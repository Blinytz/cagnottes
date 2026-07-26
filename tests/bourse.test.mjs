// Tests de la Bourse : conversion Éclats → euros, taux figé, plafonnement,
// idempotence, et impossibilité d'arbitrer sur les variations du taux.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBourse, CONVERSION_STATUT, CONVERSIONS_KEY } from '../js/bourse.js';
import { createRegistreLocal } from '../js/eclats-local.js';

function fakeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _map: m,
  };
}

// Faux moteur de taux : on pilote la valeur à la main.
function fakeTaux(valeur = 1.0) {
  const api = {
    valeur,
    actuel: () => api.valeur,
    zone: () => (api.valeur <= 0.768 ? 'basse' : api.valeur >= 1.168 ? 'haute' : 'neutre'),
    centimesPour: (eclats, t = api.valeur) => Math.floor(eclats * t * 100 / 100),
  };
  return api;
}

// Registre d'Éclats : le local fait l'affaire (même contrat que le commun).
function fabrique({ eclatsDispo = 1000, taux = 1.0 } = {}) {
  let n = 0;
  const uid = () => `id-${++n}`;
  const storage = fakeStorage();
  const registre = createRegistreLocal({ storage, uid, cle: 'test_eclats' });
  if (eclatsDispo > 0) {
    registre._inserer({
      amount: eclatsDispo, appId: 'test', kind: 'reward', reason: 'dotation',
      referenceType: 'test', referenceId: null, idempotencyKey: 'test:dotation',
    });
  }
  const journal = createRegistreLocal({ storage, uid, cle: 'test_bourse' });
  const moteur = fakeTaux(taux);
  const bourse = createBourse({ journal, eclats: registre, taux: moteur, storage, uid });
  return { bourse, registre, journal, moteur, storage, uid };
}

test('conversion simple : les Éclats sortent, les euros entrent', async () => {
  const { bourse, registre } = fabrique({ eclatsDispo: 1000, taux: 1.0 });
  const r = await bourse.convertir(500);
  assert.equal(r.ok, true);
  assert.equal(r.eclats, 500);
  assert.equal(r.centimes, 500);              // 500 ✦ à 1.00 → 5,00 €
  assert.equal(await registre.solde(), 500);  // Éclats restants
  assert.equal(bourse.soldeCentimes(), 500);  // 5,00 € en Bourse
});

test('le taux haut rapporte plus, le taux bas moins', async () => {
  const haut = fabrique({ eclatsDispo: 1000, taux: 1.4 });
  const rh = await haut.bourse.convertir(100);
  assert.equal(rh.centimes, 140);             // 1,40 €

  const bas = fabrique({ eclatsDispo: 1000, taux: 0.6 });
  const rb = await bas.bourse.convertir(100);
  assert.equal(rb.centimes, 60);              // 0,60 €
});

test('conversion supérieure au solde : plafonnée, euros cohérents', async () => {
  const { bourse, registre } = fabrique({ eclatsDispo: 300, taux: 1.0 });
  const r = await bourse.convertir(1000);
  assert.equal(r.ok, true);
  assert.equal(r.eclats, 300);                // plafonné au solde réel
  assert.equal(r.ajuste, true);
  assert.equal(r.centimes, 300);              // euros sur les Éclats DÉPENSÉS
  assert.equal(await registre.solde(), 0);
  assert.equal(bourse.soldeCentimes(), 300);
});

test('aucun Éclat disponible : conversion refusée, rien ne bouge', async () => {
  const { bourse, registre } = fabrique({ eclatsDispo: 0, taux: 1.0 });
  const r = await bourse.convertir(100);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'eclats_insuffisants');
  assert.equal(bourse.soldeCentimes(), 0);
  assert.equal(await registre.solde(), 0);
});

test('double clic : une seule conversion', async () => {
  const { bourse } = fabrique({ eclatsDispo: 1000, taux: 1.0 });
  const [a, b] = await Promise.all([bourse.convertir(200), bourse.convertir(200)]);
  const ok = [a, b].filter((x) => x.ok);
  const bloque = [a, b].filter((x) => !x.ok && x.reason === 'en_cours');
  assert.equal(ok.length, 1);
  assert.equal(bloque.length, 1);
  assert.equal(bourse.soldeCentimes(), 200);
});

test('ARBITRAGE IMPOSSIBLE : un rejeu applique le taux figé, pas le taux actuel', async () => {
  const { bourse, moteur, registre } = fabrique({ eclatsDispo: 1000, taux: 0.6 });
  // Panne réseau au moment de la conversion, taux bas.
  const casse = registre.depenser;
  registre.depenser = async () => { throw new Error('Échec réseau'); };
  const r1 = await bourse.convertir(500);
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, 'reseau');
  assert.equal(bourse.soldeCentimes(), 0);

  // Le réseau revient... et le taux a grimpé au maximum entre-temps.
  registre.depenser = casse;
  moteur.valeur = 1.4;
  const r2 = await bourse.reprendre(r1.conversionId);
  assert.equal(r2.ok, true);
  assert.equal(r2.taux, 0.6, 'le taux doit rester celui de la demande');
  assert.equal(r2.centimes, 300, '500 ✦ à 0,6 = 3,00 € — pas 7,00 €');
  assert.equal(bourse.soldeCentimes(), 300);
});

test('rejeu réseau : les Éclats ne sont débités qu’une fois', async () => {
  const { bourse, registre } = fabrique({ eclatsDispo: 1000, taux: 1.0 });
  // La dépense aboutit côté registre mais la réponse est perdue.
  const vraie = registre.depenser;
  let appels = 0;
  registre.depenser = async (args) => {
    appels++;
    const res = await vraie(args);
    if (appels === 1) throw new Error('Échec réseau : réponse perdue');
    return res;
  };
  const r1 = await bourse.convertir(400);
  assert.equal(r1.ok, false);

  const r2 = await bourse.reprendre(r1.conversionId);
  assert.equal(r2.ok, true);
  assert.equal(r2.eclats, 400);
  assert.equal(await registre.solde(), 600, 'débité une seule fois');
  assert.equal(bourse.soldeCentimes(), 400, 'crédité une seule fois');
});

test('reprendre une conversion déjà confirmée ne recrédite rien', async () => {
  const { bourse } = fabrique({ eclatsDispo: 1000, taux: 1.0 });
  const r = await bourse.convertir(250);
  const encore = await bourse.reprendre(r.conversionId);
  assert.equal(encore.ok, true);
  assert.equal(encore.idempotentReplay, true);
  assert.equal(bourse.soldeCentimes(), 250);
});

test('la conversion est définitive : aucune annulation n’est exposée', () => {
  const { bourse } = fabrique();
  assert.equal(typeof bourse.convertir, 'function');
  assert.equal(bourse.annuler, undefined);
  assert.equal(bourse.rembourser, undefined);
});

test('les conversions confirmées survivent au rechargement', async () => {
  const { bourse, storage, journal, registre, moteur, uid } = fabrique({ eclatsDispo: 1000 });
  const r = await bourse.convertir(300);
  assert.equal(r.ok, true);

  const rouverte = createBourse({ journal, eclats: registre, taux: moteur, storage, uid });
  assert.equal(rouverte.soldeCentimes(), 300);
  assert.equal(rouverte.conversion(r.conversionId).statut, CONVERSION_STATUT.CONFIRMEE);
  assert.equal(rouverte.totaux().eclats, 300);
  assert.ok(storage.getItem(CONVERSIONS_KEY));
});

test('simuler n’engage rien', async () => {
  const { bourse, registre } = fabrique({ eclatsDispo: 1000, taux: 1.2 });
  const apercu = bourse.simuler(500);
  assert.equal(apercu.centimes, 600);         // 500 ✦ × 1,2 = 6,00 €
  assert.equal(apercu.taux, 1.2);
  assert.equal(await registre.solde(), 1000); // rien n'a bougé
  assert.equal(bourse.soldeCentimes(), 0);
});

test('les totaux ne comptent que les conversions confirmées', async () => {
  const { bourse, registre } = fabrique({ eclatsDispo: 1000, taux: 1.0 });
  await bourse.convertir(200);
  registre.depenser = async () => { throw new Error('Échec réseau'); };
  await bourse.convertir(300);
  const t = bourse.totaux();
  assert.equal(t.nb, 1);
  assert.equal(t.eclats, 200);
  assert.equal(t.centimes, 200);
  assert.equal(bourse.enSouffrance().length, 1);
});
