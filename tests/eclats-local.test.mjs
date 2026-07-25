// Le registre LOCAL doit se comporter exactement comme le registre commun :
// ces tests rejouent les garanties de `apps/pronos/sql/registre_commun.sql`
// (plafond au solde, idempotence par clé, remboursement exactement-une-fois).
// Toute divergence ici se traduirait par un changement de comportement le jour
// de la bascule — c'est précisément ce qu'on veut interdire.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRegistreLocal, LEDGER_STORAGE_KEY } from '../js/eclats-local.js';

function fakeStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _map: m,
  };
}

let n = 0;
const uid = () => `mv-${++n}`;

function registreAvec(solde, storage = fakeStorage()) {
  const r = createRegistreLocal({ storage, uid });
  if (solde) {
    r._inserer({
      amount: solde, appId: 'cagnottes', kind: 'adjustment',
      reason: 'Ouverture', referenceType: 'ouverture', referenceId: null,
      idempotencyKey: 'cagnottes:ouverture:test',
    });
  }
  return r;
}

const versement = (montant, ref) => ({
  appId: 'cagnottes', montant, reason: 'Versement',
  referenceType: 'cagnotte_versement', referenceId: ref,
  idempotencyKey: `cagnottes:versement:${ref}`,
});

const remboursement = (ref) => ({
  appId: 'cagnottes', reason: 'Annulation',
  referenceType: 'cagnotte_versement', referenceId: ref,
  idempotencyKey: `cagnottes:remboursement:${ref}`,
});

test('le solde est la somme du journal, jamais une valeur stockée', async () => {
  const r = registreAvec(100);
  await r.depenser(versement(30, 'a'));
  assert.equal(await r.solde(), 70);
  assert.equal(r._etat().mouvements.length, 2);
});

test('une dépense est plafonnée au solde disponible', async () => {
  const r = registreAvec(50);
  const res = await r.depenser(versement(80, 'a'));
  assert.equal(res.amount, 50);
  assert.equal(res.adjusted, true);
  assert.equal(await r.solde(), 0);
});

test('solde nul : la dépense est refusée, rien n’est écrit', async () => {
  const r = registreAvec(0);
  await assert.rejects(() => r.depenser(versement(10, 'a')), /Solde insuffisant/);
  assert.equal(r._etat().mouvements.length, 0);
});

test('même clé d’idempotence : aucun second débit', async () => {
  const r = registreAvec(100);
  const a = await r.depenser(versement(40, 'a'));
  const b = await r.depenser(versement(40, 'a'));
  assert.equal(a.idempotent_replay, false);
  assert.equal(b.idempotent_replay, true);
  assert.equal(b.amount, 40);
  assert.equal(await r.solde(), 60);
});

test('remboursement : rend exactement la dépense, une seule fois', async () => {
  const r = registreAvec(100);
  await r.depenser(versement(60, 'a'));
  const a = await r.rembourser(remboursement('a'));
  const b = await r.rembourser(remboursement('a'));
  assert.equal(a.amount, 60);
  assert.equal(b.idempotent_replay, true);
  assert.equal(await r.solde(), 100);
  assert.equal(r._etat().mouvements.filter(m => m.kind === 'refund').length, 1);
});

test('remboursement sans dépense correspondante : refusé', async () => {
  const r = registreAvec(100);
  await assert.rejects(() => r.rembourser(remboursement('inconnu')),
    /Aucune dépense à rembourser/);
});

test('un remboursement plafonné ne rend que ce qui a été consommé', async () => {
  const r = registreAvec(30);
  const dep = await r.depenser(versement(100, 'a')); // plafonné à 30
  assert.equal(dep.amount, 30);
  const rem = await r.rembourser(remboursement('a'));
  assert.equal(rem.amount, 30);
  assert.equal(await r.solde(), 30);
});

test('le journal survit au rechargement de la page', async () => {
  const storage = fakeStorage();
  const r1 = registreAvec(100, storage);
  await r1.depenser(versement(25, 'a'));
  const r2 = createRegistreLocal({ storage, uid });
  assert.equal(await r2.solde(), 75);
  assert.ok(storage.getItem(LEDGER_STORAGE_KEY));
});

test('agrégats par application : même forme que la RPC de Centrale', async () => {
  const r = registreAvec(100);
  await r.depenser(versement(40, 'a'));
  const [agg] = await r.agregatsParApp();
  assert.equal(agg.app_id, 'cagnottes');
  assert.equal(agg.balance, 60);
  assert.equal(agg.gained, 100);
  assert.equal(agg.spent, 40);
  assert.equal(agg.movements, 2);
});

test('les montants restent entiers : l’Éclat est indivisible', async () => {
  const r = registreAvec(100);
  const res = await r.depenser(versement(10.6, 'a'));
  assert.equal(res.amount, 11);
  assert.equal(await r.solde(), 89);
  assert.ok(Number.isInteger(await r.solde()));
});
