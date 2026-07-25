// Bascule des données euro vers les Éclats (1 € = 100 ✦).
//
// Ce que ces tests protègent : après conversion, l'utilisateur doit retrouver
// EXACTEMENT ses cagnottes, au centième près converti en Éclats entiers, avec
// un journal de versements cohérent — puisque le montant d'une cagnotte n'est
// plus stocké mais dérivé de ce journal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  convertirEtatV1, etatInitial, estFormatEuro,
  TAUX_EURO_ECLAT, SOLDE_INITIAL_ECLATS, VERSION_ECLATS,
} from '../js/eclats-migration.js';
import { createRegistreLocal } from '../js/eclats-local.js';
import { createCagnottesEclats } from '../js/eclats-cagnottes.js';

let n = 0;
const uid = () => `id-${++n}`;

function fakeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

function cagnotte(over = {}) {
  return {
    id: 'c1', nom: 'Manette', image: { type: 'emoji', value: '🎮' },
    description: '', objectif: 60, montantActuel: 12.5, palier: 0.5,
    statut: 'en_cours', dateCreation: '2026-07-01T10:00:00.000Z',
    dateArchivage: null, ordreAffichage: 1,
    historiqueJournalier: [], mouvements: [],
    ...over,
  };
}

const etatEuro = (cagnottes, solde = 7.25) => ({
  version: 1,
  bourse: { solde, mouvements: [], historiqueJournalier: [] },
  cagnottes,
  ordreManuel: false,
});

const engage = (versements, cagnotteId) => Object.values(versements)
  .filter(v => v.cagnotteId === cagnotteId && v.statut === 'confirme'
    && v.refund?.statut !== 'confirme')
  .reduce((s, v) => s + v.amount, 0);

test('objectifs et paliers sont convertis au taux, sans décimale', () => {
  const { etat } = convertirEtatV1(etatEuro([cagnotte()]), { uid });
  const c = etat.cagnottes[0];
  assert.equal(c.objectif, 6000);
  assert.equal(c.palier, 50);
  assert.ok(Number.isInteger(c.objectif) && Number.isInteger(c.palier));
});

test('le montant d’une cagnotte est préservé, converti au taux', () => {
  const { versements, rapport } = convertirEtatV1(etatEuro([cagnotte()]), { uid });
  assert.equal(engage(versements, 'c1'), 1250);   // 12,50 € → 1 250 ✦
  assert.equal(rapport.totalEngage, 1250);
  assert.equal(rapport.taux, TAUX_EURO_ECLAT);
});

test('l’état converti n’a plus de Bourse et porte la version Éclats', () => {
  const { etat, rapport } = convertirEtatV1(etatEuro([cagnotte()], 7.25), { uid });
  assert.equal(etat.version, VERSION_ECLATS);
  assert.equal(etat.bourse, undefined);
  // Le solde euro n'est pas reporté : il est remplacé par le solde d'ouverture.
  assert.equal(rapport.soldeEuroAbandonne, 7.25);
  assert.equal(rapport.soldeInitial, SOLDE_INITIAL_ECLATS);
});

test('l’historique est rejoué en versements datés, pas recopié', () => {
  const c = cagnotte({
    montantActuel: 3,
    mouvements: [
      { id: 'm1', date: '2026-07-02T09:00:00.000Z', montant: 2, note: 'lundi' },
      { id: 'm2', date: '2026-07-03T09:00:00.000Z', montant: 1 },
    ],
  });
  const { versements } = convertirEtatV1(etatEuro([c]), { uid });
  const liste = Object.values(versements);
  assert.equal(liste.length, 2);
  assert.deepEqual(liste.map(v => v.amount).sort((a, b) => a - b), [100, 200]);
  assert.equal(liste.find(v => v.amount === 200).confirmedAt, '2026-07-02T09:00:00.000Z');
  assert.equal(liste.find(v => v.amount === 200).note, 'lundi');
  assert.equal(engage(versements, 'c1'), 300);
});

test('un retrait annule les versements les plus récents (LIFO)', () => {
  const c = cagnotte({
    montantActuel: 3,
    mouvements: [
      { id: 'm1', date: '2026-07-02T09:00:00.000Z', montant: 2 },
      { id: 'm2', date: '2026-07-03T09:00:00.000Z', montant: 2 },
      { id: 'm3', date: '2026-07-04T09:00:00.000Z', montant: -1 },
    ],
  });
  const { versements } = convertirEtatV1(etatEuro([c]), { uid });
  const liste = Object.values(versements);
  // Le versement de 200 ✦ le plus récent est remboursé en entier, et son
  // reliquat (100 ✦) re-versé : le registre ne rembourse pas à moitié.
  const rembourses = liste.filter(v => v.refund?.statut === 'confirme');
  assert.equal(rembourses.length, 1);
  assert.equal(rembourses[0].amount, 200);
  assert.equal(engage(versements, 'c1'), 300);
});

test('un montant sans historique est reconstitué à la date de création', () => {
  const c = cagnotte({ montantActuel: 5, mouvements: [] });
  const { versements } = convertirEtatV1(etatEuro([c]), { uid });
  const liste = Object.values(versements);
  assert.equal(liste.length, 1);
  assert.equal(liste[0].amount, 500);
  assert.equal(liste[0].confirmedAt, '2026-07-01T10:00:00.000Z');
});

test('un historique incohérent est recalé sur le montant affiché', () => {
  // L'historique ne raconte que 2 €, mais la cagnotte en affiche 10 :
  // c'est le montant affiché qui fait foi pour l'utilisateur.
  const c = cagnotte({
    montantActuel: 10,
    mouvements: [{ id: 'm1', date: '2026-07-02T09:00:00.000Z', montant: 2 }],
  });
  const { versements } = convertirEtatV1(etatEuro([c]), { uid });
  assert.equal(engage(versements, 'c1'), 1000);
});

test('une cagnotte archivée garde ses Éclats et son statut', () => {
  const c = cagnotte({
    statut: 'archivée', montantActuel: 60, objectif: 60,
    dateArchivage: '2026-07-20T10:00:00.000Z',
  });
  const { etat, versements } = convertirEtatV1(etatEuro([c]), { uid });
  assert.equal(etat.cagnottes[0].statut, 'archivée');
  assert.equal(engage(versements, 'c1'), 6000);
});

test('après rejeu du journal, le disponible vaut le solde d’ouverture', async () => {
  const source = etatEuro([
    cagnotte({ id: 'c1', montantActuel: 12.5 }),
    cagnotte({
      id: 'c2', montantActuel: 4,
      mouvements: [
        { id: 'm1', date: '2026-07-02T09:00:00.000Z', montant: 6 },
        { id: 'm2', date: '2026-07-05T09:00:00.000Z', montant: -2 },
      ],
    }),
  ]);
  const { versements, mouvements, rapport } = convertirEtatV1(source, { uid });

  const registre = createRegistreLocal({ storage: fakeStorage(), uid });
  mouvements.forEach(m => registre._inserer(m));
  const eclats = createCagnottesEclats({ ledger: registre, storage: fakeStorage(), uid });
  eclats.remplacerVersements(versements);

  assert.equal(await registre.solde(), SOLDE_INITIAL_ECLATS);
  assert.equal(eclats.engageDe('c1'), 1250);
  assert.equal(eclats.engageDe('c2'), 400);
  assert.equal(rapport.ouverture, SOLDE_INITIAL_ECLATS + 1650);
});

test('les versements convertis restent annulables après la bascule', async () => {
  const { versements, mouvements } = convertirEtatV1(etatEuro([cagnotte()]), { uid });
  const registre = createRegistreLocal({ storage: fakeStorage(), uid });
  mouvements.forEach(m => registre._inserer(m));
  const eclats = createCagnottesEclats({ ledger: registre, storage: fakeStorage(), uid });
  eclats.remplacerVersements(versements);

  const dernier = eclats.dernierAnnulable('c1');
  assert.ok(dernier);
  const res = await eclats.annuler(dernier.id);
  assert.equal(res.ok, true);
  assert.equal(res.amount, 1250);
  assert.equal(eclats.engageDe('c1'), 0);
  assert.equal(await registre.solde(), SOLDE_INITIAL_ECLATS + 1250);
});

test('installation neuve : pas de conversion, juste le solde d’ouverture', async () => {
  const { etat, versements, mouvements } = etatInitial();
  assert.equal(etat.version, VERSION_ECLATS);
  assert.deepEqual(etat.cagnottes, []);
  assert.deepEqual(versements, {});
  const registre = createRegistreLocal({ storage: fakeStorage(), uid });
  mouvements.forEach(m => registre._inserer(m));
  assert.equal(await registre.solde(), SOLDE_INITIAL_ECLATS);
});

test('la bascule ne peut pas être rejouée : l’ouverture est idempotente', async () => {
  const { mouvements } = convertirEtatV1(etatEuro([cagnotte()]), { uid });
  const registre = createRegistreLocal({ storage: fakeStorage(), uid });
  mouvements.forEach(m => registre._inserer(m));
  const apres = await registre.solde();
  mouvements.forEach(m => registre._inserer(m)); // second passage
  assert.equal(await registre.solde(), apres);
});

test('reconnaissance du format : euro avant bascule, Éclats après', () => {
  assert.equal(estFormatEuro(etatEuro([cagnotte()])), true);
  const { etat } = convertirEtatV1(etatEuro([cagnotte()]), { uid });
  assert.equal(estFormatEuro(etat), false);
});
