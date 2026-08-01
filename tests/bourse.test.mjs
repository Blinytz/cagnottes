// Tests de la Bourse : conversion Éclats ↔ euros à la parité fixe 100 ✦ = 1 €,
// plafonnement, idempotence, et reprise d'un montant libre.
//
// Ce que ces tests protègent avant tout : Cagnottes ne doit JAMAIS pouvoir
// fabriquer des Éclats. Toute reprise passe par le remboursement de dépenses
// réellement enregistrées, et seul le solde de la Bourse est reprenable —
// ce qui est déjà versé dans une cagnotte ne l'est pas.
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

/* Libère des euros engagés, comme la suppression d'une cagnotte. */
async function liberer(journal, ref = 'v1') {
  return journal.rembourser({
    appId: 'cagnottes', referenceType: 'cagnotte_versement', referenceId: ref,
    reason: 'Suppression de la cagnotte',
    idempotencyKey: `cagnottes:remboursement:${ref}`,
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

// ---- Rendre des euros sous forme d'Éclats (montant libre) ----

test('rendre tout : retour exact au point de départ', async () => {
  const { bourse, registre } = fabrique({ eclatsDispo: 1000 });
  await bourse.convertir(400);
  assert.equal(await registre.solde(), 600);

  const r = await bourse.rendre(400);
  assert.equal(r.ok, true);
  assert.equal(r.centimes, 400);
  assert.equal(bourse.soldeCentimes(), 0);
  assert.equal(await registre.solde(), 1000);
});

test('RENDRE UNE PARTIE : le reliquat est reconverti, rien ne se perd', async () => {
  const { bourse, registre } = fabrique({ eclatsDispo: 5000 });
  await bourse.convertir(5000);                 // une seule conversion de 50,00 €
  assert.equal(bourse.soldeCentimes(), 5000);

  const r = await bourse.rendre(2000);          // on ne rend que 20,00 €
  assert.equal(r.ok, true);
  assert.equal(r.centimes, 2000);
  assert.equal(await registre.solde(), 2000, '2 000 ✦ rendus, pas 5 000');
  assert.equal(bourse.soldeCentimes(), 3000, '30,00 € conservés');

  // Les euros conservés restent adossés à des Éclats réellement dépensés.
  assert.equal(bourse.totaux().centimes, 3000);
  assert.equal(bourse.totaux().eclats, 3000);
});

test('rendre par petits bouts successifs reste exact', async () => {
  const { bourse, registre } = fabrique({ eclatsDispo: 5000 });
  await bourse.convertir(5000);
  for (const part of [700, 300, 1000]) {
    const r = await bourse.rendre(part);
    assert.equal(r.ok, true, `reprise de ${part} refusée`);
  }
  assert.equal(await registre.solde(), 2000);
  assert.equal(bourse.soldeCentimes(), 3000);
  assert.equal(bourse.totaux().centimes, 3000, 'adossement toujours cohérent');
});

test('une reprise peut traverser plusieurs conversions', async () => {
  const { bourse, registre } = fabrique({ eclatsDispo: 1000 });
  await bourse.convertir(300);
  await bourse.convertir(300);
  await bourse.convertir(300);                  // 9,00 € en trois fois
  const r = await bourse.rendre(700);           // dépasse deux conversions
  assert.equal(r.ok, true);
  assert.equal(await registre.solde(), 800);    // 100 restants + 700 rendus
  assert.equal(bourse.soldeCentimes(), 200);
  assert.equal(bourse.totaux().centimes, 200);
});

test('SEULE LA BOURSE est reprenable : l’engagé en cagnotte ne l’est pas', async () => {
  const { bourse, journal, registre } = fabrique({ eclatsDispo: 5000 });
  await bourse.convertir(5000);
  await engager(journal, 3000);                 // 30,00 € partis en cagnotte
  assert.equal(bourse.maxRendable(), 2000);

  const trop = await bourse.rendre(2500);
  assert.equal(trop.ok, false);
  assert.equal(trop.reason, 'solde_insuffisant');
  assert.equal(bourse.soldeCentimes(), 2000, 'rien n’a bougé');
  assert.equal(await registre.solde(), 0);

  // Ce qui reste dans la Bourse, lui, est bien reprenable.
  const ok = await bourse.rendre(2000);
  assert.equal(ok.ok, true);
  assert.equal(await registre.solde(), 2000);
  assert.equal(bourse.soldeCentimes(), 0);
});

test('après libération des euros d’une cagnotte, ils redeviennent reprenables', async () => {
  const { bourse, journal, registre } = fabrique({ eclatsDispo: 5000 });
  await bourse.convertir(5000);
  await engager(journal, 3000);
  assert.equal(bourse.maxRendable(), 2000);

  await liberer(journal);                       // suppression de la cagnotte
  assert.equal(bourse.maxRendable(), 5000);
  const r = await bourse.rendre(5000);
  assert.equal(r.ok, true);
  assert.equal(await registre.solde(), 5000);
});

test('AUCUNE CRÉATION : un montant supérieur au solde est refusé', async () => {
  const { bourse, registre } = fabrique({ eclatsDispo: 1000 });
  await bourse.convertir(400);
  const r = await bourse.rendre(900);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'solde_insuffisant');
  assert.equal(await registre.solde(), 600, 'aucun Éclat créé');
  assert.equal(bourse.soldeCentimes(), 400);
});

test('panne réseau pendant une reprise : rejouable, rien de perdu ni de créé', async () => {
  const { bourse, registre } = fabrique({ eclatsDispo: 5000 });
  await bourse.convertir(5000);

  const vraie = registre.rembourser;
  registre.rembourser = async () => { throw new Error('Échec réseau'); };
  const r1 = await bourse.rendre(2000);
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, 'reseau');
  assert.equal(bourse.soldeCentimes(), 3000, 'les euros ont quitté la Bourse');
  assert.equal(await registre.solde(), 0, 'les Éclats ne sont pas encore rendus');
  assert.equal(bourse.reprisesInachevees().length, 1, 'signalée pour rejeu');

  registre.rembourser = vraie;
  const r2 = await bourse.reprendreReprise(r1.repriseId);
  assert.equal(r2.ok, true);
  assert.equal(await registre.solde(), 2000);
  assert.equal(bourse.soldeCentimes(), 3000);
  assert.equal(bourse.reprisesInachevees().length, 0);
});

test('coupure APRÈS remboursement : le rejeu reconvertit le reliquat', async () => {
  const { bourse, registre } = fabrique({ eclatsDispo: 5000 });
  await bourse.convertir(5000);

  // Le remboursement passe, la reconversion du reliquat échoue.
  const vraie = registre.depenser;
  let coupe = true;
  registre.depenser = async (args) => {
    if (coupe) throw new Error('Échec réseau');
    return vraie(args);
  };
  const r1 = await bourse.rendre(2000);
  assert.equal(r1.ok, false);
  assert.equal(await registre.solde(), 5000, 'tout est revenu, trop pour l’instant');
  assert.equal(bourse.soldeCentimes(), 3000);

  coupe = false;
  const r2 = await bourse.reprendreReprise(r1.repriseId);
  assert.equal(r2.ok, true);
  assert.equal(await registre.solde(), 2000, 'le reliquat est bien redépensé');
  assert.equal(bourse.soldeCentimes(), 3000);
  assert.equal(bourse.totaux().centimes, 3000);
});

// ---- Conversions héritées de la période à taux variable ----
//
// Avant la parité fixe, une conversion pouvait dépenser 1 000 ✦ pour ne
// créditer que 6,00 € (taux 0,60) ou au contraire 12,00 € (taux 1,40). Le
// remboursement rend les Éclats RÉELLEMENT dépensés : sans précaution, rendre
// ces euros en fabriquerait ou en détruirait.

/* Injecte une conversion héritée : `eclats` dépensés ≠ `centimes` crédités. */
async function heriter({ bourse, journal, registre }, { eclats, centimes, ref = 'legacy' }) {
  // Les Éclats ont bien été gagnés puis dépensés : le registre retombe à zéro.
  registre._inserer({
    amount: eclats, appId: 'test', kind: 'reward', reason: 'gains passés',
    referenceType: 'test', referenceId: null, idempotencyKey: `test:dotation:${ref}`,
  });
  registre._inserer({
    amount: -eclats, appId: 'cagnottes', kind: 'spend', reason: 'Conversion (taux variable)',
    referenceType: 'conversion_euro', referenceId: ref,
    idempotencyKey: `cagnottes:conversion:${ref}`,
  });
  await journal.crediter({
    appId: 'cagnottes', montant: centimes, reason: 'Conversion héritée',
    referenceType: 'conversion_euro', referenceId: ref,
    idempotencyKey: `cagnottes:credit-conversion:${ref}`,
  });
  bourse._etat().conversions[ref] = {
    id: ref, eclatsDemandes: eclats, eclats, centimes,
    statut: CONVERSION_STATUT.CONFIRMEE,
    createdAt: '2026-07-28T10:00:00.000Z', confirmedAt: '2026-07-28T10:00:00.000Z',
    movementId: 'legacy', ajuste: false, repriseId: null, erreur: null,
  };
}

test('AUCUNE CRÉATION sur une conversion héritée à taux bas', async () => {
  // 1 000 ✦ avaient été dépensés pour seulement 6,00 € (taux 0,60).
  const f = fabrique({ eclatsDispo: 0 });
  await heriter(f, { eclats: 1000, centimes: 600 });
  assert.equal(f.bourse.soldeCentimes(), 600);

  const r = await f.bourse.rendre(600);
  assert.equal(r.ok, true);
  assert.equal(await f.registre.solde(), 600,
    '600 centimes rendus doivent donner 600 ✦, pas les 1 000 dépensés');
  assert.equal(f.bourse.soldeCentimes(), 0);
});

test('AUCUNE DESTRUCTION sur une conversion héritée à taux haut', async () => {
  // 1 000 ✦ avaient rapporté 12,00 € (taux 1,20) : 2,00 € ne sont adossés à rien.
  const f = fabrique({ eclatsDispo: 0 });
  await heriter(f, { eclats: 1000, centimes: 1200 });
  assert.equal(f.bourse.soldeCentimes(), 1200);
  assert.equal(f.bourse.maxRendable(), 1000, 'plafonné aux Éclats réellement dépensés');

  const trop = await f.bourse.rendre(1200);
  assert.equal(trop.ok, false);
  assert.equal(trop.reason, 'solde_insuffisant');

  const r = await f.bourse.rendre(1000);
  assert.equal(r.ok, true);
  assert.equal(await f.registre.solde(), 1000, 'rendu à parité, sans perte');
  assert.equal(f.bourse.soldeCentimes(), 200, 'les 2,00 € non adossés restent acquis');
  assert.equal(f.bourse.totaux().centimes, 200, 'et restent tracés');
});

test('reprise partielle sur une conversion héritée : parité respectée', async () => {
  const f = fabrique({ eclatsDispo: 0 });
  await heriter(f, { eclats: 1000, centimes: 600 });
  const r = await f.bourse.rendre(250);
  assert.equal(r.ok, true);
  assert.equal(await f.registre.solde(), 250, '250 centimes → 250 ✦');
  assert.equal(f.bourse.soldeCentimes(), 350);
  assert.equal(f.bourse.totaux().centimes, 350, 'invariant : solde = conversions actives');
});

test('rejouer une reprise confirmée ne rend rien de plus', async () => {
  const { bourse, registre } = fabrique({ eclatsDispo: 1000 });
  await bourse.convertir(400);
  const r = await bourse.rendre(400);
  const encore = await bourse.reprendreReprise(r.repriseId);
  assert.equal(encore.ok, true);
  assert.equal(encore.idempotentReplay, true);
  assert.equal(await registre.solde(), 1000, 'crédité une seule fois');
});

test('conversions et reprises survivent au rechargement', async () => {
  const { bourse, storage, journal, registre, uid } = fabrique({ eclatsDispo: 5000 });
  await bourse.convertir(5000);
  const r = await bourse.rendre(2000);

  const rouverte = createBourse({ journal, eclats: registre, storage, uid });
  assert.equal(rouverte.soldeCentimes(), 3000);
  assert.equal(rouverte.reprise(r.repriseId).statut, REPRISE_STATUT.CONFIRMEE);
  assert.equal(rouverte.totaux().centimes, 3000);
  assert.equal(rouverte.totaux().eclatsRendus, 2000);
  assert.ok(storage.getItem(CONVERSIONS_KEY));
});

test('simuler n’engage rien', async () => {
  const { bourse, registre } = fabrique({ eclatsDispo: 1000 });
  const apercu = bourse.simuler(500);
  assert.equal(apercu.centimes, 500);
  assert.equal(await registre.solde(), 1000);
  assert.equal(bourse.soldeCentimes(), 0);
});

test('les conversions en erreur restent signalées, sans compter', async () => {
  const { bourse, registre } = fabrique({ eclatsDispo: 1000 });
  await bourse.convertir(200);
  registre.depenser = async () => { throw new Error('Échec réseau'); };
  const rate = await bourse.convertir(300);
  assert.equal(rate.ok, false);
  assert.equal(bourse.totaux().nb, 1);
  assert.equal(bourse.totaux().centimes, 200);
  assert.equal(bourse.enSouffrance().length, 1);
  assert.equal(bourse.conversion(rate.conversionId).statut, CONVERSION_STATUT.ERREUR);
});

test('restaurer une sauvegarde remplace les DEUX journaux ensemble', async () => {
  const { bourse, journal } = fabrique({ eclatsDispo: 5000 });
  await bourse.convertir(4000);
  await engager(journal, 1000);
  await bourse.rendre(500);
  const sauvegarde = {
    conversions: JSON.parse(JSON.stringify(bourse._etat())),
    journal: JSON.parse(JSON.stringify(bourse._journalEtat())),
  };
  const attendu = bourse.soldeCentimes();

  await bourse.convertir(100);
  assert.notEqual(bourse.soldeCentimes(), attendu);

  bourse._remplacer(sauvegarde);
  assert.equal(bourse.soldeCentimes(), attendu, 'solde restauré');
  assert.equal(bourse.totaux().eclatsRendus, 500, 'reprises restaurées');
});
