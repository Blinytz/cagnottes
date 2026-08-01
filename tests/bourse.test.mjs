// Tests de la Bourse : conversion Éclats ↔ euros au taux fixe 100 ✦ = 1 €,
// plafonnement, idempotence, et reprise des euros non utilisés.
//
// Ce que ces tests protègent avant tout : Cagnottes ne doit JAMAIS pouvoir
// fabriquer des Éclats. Toute reprise passe par le remboursement d'une dépense
// réellement enregistrée, et rien ne peut être rendu deux fois.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createBourse, CONVERSION_STATUT, REPRISE_STATUT, CONVERSIONS_KEY,
  ECLATS_PAR_EURO, centimesPour, eclatsPour,
} from '../js/bourse.js';
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

// Registre d'Éclats : le local fait l'affaire (même contrat que le commun).
function fabrique({ eclatsDispo = 1000 } = {}) {
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
  const bourse = createBourse({ journal, eclats: registre, storage, uid });
  return { bourse, registre, journal, storage, uid };
}

/* Retire des euros de la Bourse, comme le ferait un versement en cagnotte. */
async function engager(journal, centimes, ref = 'v1') {
  return journal.depenser({
    appId: 'cagnottes', montant: centimes, reason: 'Versement',
    referenceType: 'cagnotte_versement', referenceId: ref,
    idempotencyKey: `cagnottes:versement:${ref}`,
  });
}

test('la parité est fixe : 100 ✦ = 1 €, donc 1 Éclat = 1 centime', () => {
  assert.equal(ECLATS_PAR_EURO, 100);
  assert.equal(centimesPour(500), 500);
  assert.equal(eclatsPour(500), 500);
  assert.equal(centimesPour(0), 0);
  assert.equal(centimesPour(-10), 0);
});

test('conversion simple : les Éclats sortent, les euros entrent', async () => {
  const { bourse, registre } = fabrique({ eclatsDispo: 1000 });
  const r = await bourse.convertir(500);
  assert.equal(r.ok, true);
  assert.equal(r.eclats, 500);
  assert.equal(r.centimes, 500);              // 500 ✦ → 5,00 €
  assert.equal(await registre.solde(), 500);
  assert.equal(bourse.soldeCentimes(), 500);
});

test('conversion supérieure au solde : plafonnée, euros cohérents', async () => {
  const { bourse, registre } = fabrique({ eclatsDispo: 300 });
  const r = await bourse.convertir(1000);
  assert.equal(r.ok, true);
  assert.equal(r.eclats, 300);                // plafonné au solde réel
  assert.equal(r.ajuste, true);
  assert.equal(r.centimes, 300);              // euros sur les Éclats DÉPENSÉS
  assert.equal(await registre.solde(), 0);
  assert.equal(bourse.soldeCentimes(), 300);
});

test('aucun Éclat disponible : conversion refusée, rien ne bouge', async () => {
  const { bourse, registre } = fabrique({ eclatsDispo: 0 });
  const r = await bourse.convertir(100);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'eclats_insuffisants');
  assert.equal(bourse.soldeCentimes(), 0);
  assert.equal(await registre.solde(), 0);
});

test('double clic : une seule conversion', async () => {
  const { bourse } = fabrique({ eclatsDispo: 1000 });
  const [a, b] = await Promise.all([bourse.convertir(200), bourse.convertir(200)]);
  assert.equal([a, b].filter((x) => x.ok).length, 1);
  assert.equal([a, b].filter((x) => !x.ok && x.reason === 'en_cours').length, 1);
  assert.equal(bourse.soldeCentimes(), 200);
});

test('rejeu réseau : les Éclats ne sont débités qu’une fois', async () => {
  const { bourse, registre } = fabrique({ eclatsDispo: 1000 });
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
  const { bourse } = fabrique({ eclatsDispo: 1000 });
  const r = await bourse.convertir(250);
  const encore = await bourse.reprendre(r.conversionId);
  assert.equal(encore.ok, true);
  assert.equal(encore.idempotentReplay, true);
  assert.equal(bourse.soldeCentimes(), 250);
});

// ---- Rendre des euros sous forme d'Éclats ----

test('rendre : les euros quittent la Bourse, les Éclats reviennent', async () => {
  const { bourse, registre } = fabrique({ eclatsDispo: 1000 });
  const c = await bourse.convertir(400);
  assert.equal(await registre.solde(), 600);

  const r = await bourse.rendre(c.conversionId);
  assert.equal(r.ok, true);
  assert.equal(r.eclats, 400);
  assert.equal(bourse.soldeCentimes(), 0);
  assert.equal(await registre.solde(), 1000, 'retour exact au point de départ');
});

test('AUCUNE CRÉATION : rendre deux fois ne rend les Éclats qu’une fois', async () => {
  const { bourse, registre } = fabrique({ eclatsDispo: 1000 });
  const c = await bourse.convertir(400);
  const a = await bourse.rendre(c.conversionId);
  const b = await bourse.rendre(c.conversionId);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(b.idempotentReplay, true);
  assert.equal(await registre.solde(), 1000, 'crédité une seule fois');
  assert.equal(bourse.soldeCentimes(), 0, 'débité une seule fois');
});

test('des euros engagés dans une cagnotte ne peuvent pas être rendus', async () => {
  const { bourse, journal, registre } = fabrique({ eclatsDispo: 1000 });
  const c = await bourse.convertir(500);
  await engager(journal, 300);                 // 3,00 € partis en cagnotte

  const r = await bourse.rendre(c.conversionId);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'euros_engages');
  assert.equal(bourse.soldeCentimes(), 200, 'la Bourse est intacte');
  assert.equal(await registre.solde(), 500, 'aucun Éclat rendu');
});

test('la liste des reprises possibles exclut ce qui est déjà engagé', async () => {
  const { bourse, journal } = fabrique({ eclatsDispo: 1000 });
  const petite = await bourse.convertir(100);
  const grosse = await bourse.convertir(400);
  assert.equal(bourse.annulables().length, 2);

  await engager(journal, 450);                 // il ne reste que 0,50 €
  const restants = bourse.annulables().map((c) => c.id);
  assert.deepEqual(restants, [], 'aucune conversion n’est plus couverte');

  // Après annulation du versement, tout redevient reprenable.
  await journal.rembourser({
    appId: 'cagnottes', referenceType: 'cagnotte_versement', referenceId: 'v1',
    reason: 'Annulation', idempotencyKey: 'cagnottes:remboursement:v1',
  });
  const apres = bourse.annulables().map((c) => c.id).sort();
  assert.deepEqual(apres, [petite.conversionId, grosse.conversionId].sort());
});

test('panne réseau pendant une reprise : euros retirés, rejouable, rien de perdu', async () => {
  const { bourse, registre } = fabrique({ eclatsDispo: 1000 });
  const c = await bourse.convertir(400);

  const vraie = registre.rembourser;
  registre.rembourser = async () => { throw new Error('Échec réseau'); };
  const r1 = await bourse.rendre(c.conversionId);
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, 'reseau');
  assert.equal(bourse.soldeCentimes(), 0, 'les euros ont quitté la Bourse');
  assert.equal(await registre.solde(), 600, 'les Éclats ne sont pas encore rendus');
  assert.equal(bourse.enSouffrance().length, 1, 'l’opération est signalée');

  // Le réseau revient : la reprise aboutit sans re-débiter la Bourse.
  registre.rembourser = vraie;
  const r2 = await bourse.rendre(c.conversionId);
  assert.equal(r2.ok, true);
  assert.equal(bourse.soldeCentimes(), 0);
  assert.equal(await registre.solde(), 1000);
  assert.equal(bourse.enSouffrance().length, 0);
});

test('une conversion non confirmée ne peut pas être rendue', async () => {
  const { bourse, registre } = fabrique({ eclatsDispo: 1000 });
  registre.depenser = async () => { throw new Error('Échec réseau'); };
  const c = await bourse.convertir(300);
  assert.equal(c.ok, false);

  const r = await bourse.rendre(c.conversionId);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'non_comptabilisee');
});

test('les totaux ne comptent que les conversions confirmées et non rendues', async () => {
  const { bourse, registre } = fabrique({ eclatsDispo: 1000 });
  const gardee = await bourse.convertir(200);
  const rendue = await bourse.convertir(300);
  await bourse.rendre(rendue.conversionId);

  const vraie = registre.depenser;
  registre.depenser = async () => { throw new Error('Échec réseau'); };
  await bourse.convertir(100);
  registre.depenser = vraie;

  const t = bourse.totaux();
  assert.equal(t.nb, 1);
  assert.equal(t.eclats, 200);
  assert.equal(t.centimes, 200);
  assert.equal(t.nbReprises, 1);
  assert.equal(t.eclatsRendus, 300);
  assert.equal(bourse.enSouffrance().length, 1);
  assert.equal(bourse.conversion(gardee.conversionId).statut, CONVERSION_STATUT.CONFIRMEE);
  assert.equal(bourse.conversion(rendue.conversionId).reprise.statut, REPRISE_STATUT.CONFIRMEE);
});

test('conversions et reprises survivent au rechargement', async () => {
  const { bourse, storage, journal, registre, uid } = fabrique({ eclatsDispo: 1000 });
  const a = await bourse.convertir(300);
  const b = await bourse.convertir(200);
  await bourse.rendre(b.conversionId);

  const rouverte = createBourse({ journal, eclats: registre, storage, uid });
  assert.equal(rouverte.soldeCentimes(), 300);
  assert.equal(rouverte.conversion(a.conversionId).statut, CONVERSION_STATUT.CONFIRMEE);
  assert.equal(rouverte.conversion(b.conversionId).reprise.statut, REPRISE_STATUT.CONFIRMEE);
  assert.equal(rouverte.totaux().eclats, 300);
  assert.ok(storage.getItem(CONVERSIONS_KEY));
});

test('simuler n’engage rien', async () => {
  const { bourse, registre } = fabrique({ eclatsDispo: 1000 });
  const apercu = bourse.simuler(500);
  assert.equal(apercu.centimes, 500);
  assert.equal(await registre.solde(), 1000);
  assert.equal(bourse.soldeCentimes(), 0);
});

test('restaurer une sauvegarde remplace les DEUX journaux ensemble', async () => {
  const { bourse, journal } = fabrique({ eclatsDispo: 1000 });
  await bourse.convertir(700);
  await engager(journal, 200);
  const sauvegarde = {
    conversions: JSON.parse(JSON.stringify(bourse._etat())),
    journal: JSON.parse(JSON.stringify(bourse._journalEtat())),
  };
  const soldeAttendu = bourse.soldeCentimes();

  await bourse.convertir(100);                 // état divergent
  assert.notEqual(bourse.soldeCentimes(), soldeAttendu);

  bourse._remplacer(sauvegarde);
  assert.equal(bourse.soldeCentimes(), soldeAttendu, 'solde restauré');
  assert.equal(bourse.totaux().nb, 1, 'journal des conversions restauré');
});
