// Tests du contrôleur Éclats de Cagnottes contre un faux registre qui reproduit
// fidèlement la sémantique des RPC SQL (plafond au solde, idempotence par clé,
// remboursement exactement-une-fois). Lançable avec : node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCagnottesEclats, STATUT, REFUND_STATUT, ETAT_STORAGE_KEY,
} from '../js/eclats-cagnottes.js';

// ---- Faux stockage (partagé pour les tests de rechargement) ----
function fakeStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _map: m,
  };
}

// ---- Faux registre : miroir des RPC eclats_spend / eclats_refund / eclats_balance ----
function fakeLedger({ solde = 0 } = {}) {
  let balance = solde;
  const parCle = new Map();     // idempotency_key -> résultat mémorisé
  const mouvements = [];        // { referenceType, referenceId, kind, amount }
  const api = {
    offline: false,
    dropNextResponse: false,    // commit effectué mais réponse « perdue »
    debits: 0,
    async solde() { return balance; },
    async depenser({ montant, referenceType, referenceId, idempotencyKey }) {
      if (api.offline) throw new Error('Échec réseau : impossible de joindre le registre');
      if (parCle.has(idempotencyKey)) {
        const r = parCle.get(idempotencyKey);
        return { ...r, idempotent_replay: true };
      }
      const available = Math.max(balance, 0);
      const spent = Math.min(montant, available);
      if (spent <= 0) throw new Error('Solde insuffisant : aucun Éclat disponible');
      balance -= spent;
      api.debits += 1;
      mouvements.push({ referenceType, referenceId, kind: 'spend', amount: -spent });
      const res = {
        movement_id: `mv-${mouvements.length}`,
        amount: spent, requested: montant,
        adjusted: spent < montant, balance_after: balance,
        idempotent_replay: false,
      };
      parCle.set(idempotencyKey, res);
      if (api.dropNextResponse) { api.dropNextResponse = false; throw new Error('Échec réseau : réponse perdue'); }
      return res;
    },
    async rembourser({ referenceType, referenceId, idempotencyKey }) {
      if (api.offline) throw new Error('Échec réseau : impossible de joindre le registre');
      if (parCle.has(idempotencyKey)) {
        const r = parCle.get(idempotencyKey);
        return { ...r, idempotent_replay: true };
      }
      const spent = -mouvements
        .filter((m) => m.referenceType === referenceType && m.referenceId === referenceId
          && m.kind === 'spend' && m.amount < 0)
        .reduce((s, m) => s + m.amount, 0);
      if (spent <= 0) throw new Error('Aucune dépense à rembourser pour cette référence');
      const already = mouvements
        .filter((m) => m.referenceType === referenceType && m.referenceId === referenceId
          && m.kind === 'refund')
        .reduce((s, m) => s + m.amount, 0);
      const refund = spent - already;
      if (refund <= 0) throw new Error('Dépense déjà remboursée');
      balance += refund;
      mouvements.push({ referenceType, referenceId, kind: 'refund', amount: refund });
      const res = {
        movement_id: `mv-${mouvements.length}`,
        amount: refund, balance_after: balance, idempotent_replay: false,
      };
      parCle.set(idempotencyKey, res);
      return res;
    },
    _balance: () => balance,
    _mouvements: () => mouvements,
  };
  return api;
}

let compteur = 0;
const uid = () => `v-${++compteur}`;

test('versement normal : débit confirmé et engagé mis à jour', async () => {
  const ledger = fakeLedger({ solde: 100 });
  const ec = createCagnottesEclats({ ledger, storage: fakeStorage(), uid });
  const r = await ec.verser('c1', 40);
  assert.equal(r.ok, true);
  assert.equal(r.amount, 40);
  assert.equal(r.adjusted, false);
  assert.equal(await ec.soldeDisponible(), 60);
  assert.equal(ec.engageDe('c1'), 40);
  assert.equal(ec.versement(r.versementId).statut, STATUT.CONFIRME);
});

test('versement supérieur au solde : plafonné au disponible', async () => {
  const ledger = fakeLedger({ solde: 50 });
  const ec = createCagnottesEclats({ ledger, storage: fakeStorage(), uid });
  const r = await ec.verser('c1', 100);
  assert.equal(r.ok, true);
  assert.equal(r.amount, 50);
  assert.equal(r.adjusted, true);
  assert.equal(await ec.soldeDisponible(), 0);
});

test('solde nul : versement refusé, rien de comptabilisé', async () => {
  const ledger = fakeLedger({ solde: 0 });
  const ec = createCagnottesEclats({ ledger, storage: fakeStorage(), uid });
  const r = await ec.verser('c1', 20);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'solde_insuffisant');
  assert.equal(ec.engageDe('c1'), 0);
  assert.equal(ledger.debits, 0);
  assert.equal(ec.versement(r.versementId).statut, STATUT.REFUSE);
});

test('double clic : un seul versement créé, un seul débit', async () => {
  const ledger = fakeLedger({ solde: 100 });
  const ec = createCagnottesEclats({ ledger, storage: fakeStorage(), uid });
  const [a, b] = await Promise.all([ec.verser('c1', 30), ec.verser('c1', 30)]);
  const oks = [a, b].filter((x) => x.ok);
  const refuses = [a, b].filter((x) => !x.ok && x.reason === 'en_cours');
  assert.equal(oks.length, 1);
  assert.equal(refuses.length, 1);
  assert.equal(ledger.debits, 1);
  assert.equal(await ec.soldeDisponible(), 70);
});

test('rejeu réseau : réponse perdue puis reprise ⇒ un seul débit', async () => {
  const ledger = fakeLedger({ solde: 100 });
  ledger.dropNextResponse = true; // le serveur commit mais la réponse est perdue
  const ec = createCagnottesEclats({ ledger, storage: fakeStorage(), uid });
  const r1 = await ec.verser('c1', 40);
  assert.equal(r1.ok, false);              // le client voit une erreur réseau
  assert.equal(ec.versement(r1.versementId).statut, STATUT.ERREUR);
  const r2 = await ec.reprendre(r1.versementId); // même clé
  assert.equal(r2.ok, true);
  assert.equal(r2.idempotentReplay, true);
  assert.equal(ledger.debits, 1);          // débité exactement une fois
  assert.equal(await ec.soldeDisponible(), 60);
});

test('modification d’un versement : annule l’ancien, verse le nouveau', async () => {
  const ledger = fakeLedger({ solde: 100 });
  const ec = createCagnottesEclats({ ledger, storage: fakeStorage(), uid });
  const v = await ec.verser('c1', 30);
  const ann = await ec.annuler(v.versementId);
  assert.equal(ann.ok, true);
  assert.equal(ann.amount, 30);
  const v2 = await ec.verser('c1', 50);
  assert.equal(v2.ok, true);
  assert.equal(ec.engageDe('c1'), 50);
  assert.equal(await ec.soldeDisponible(), 50); // 100 -30 +30 -50
});

test('suppression + remboursement : rembourse exactement le versement', async () => {
  const ledger = fakeLedger({ solde: 100 });
  const ec = createCagnottesEclats({ ledger, storage: fakeStorage(), uid });
  const v = await ec.verser('c1', 60);
  const ann = await ec.annuler(v.versementId, 'Suppression de la cagnotte');
  assert.equal(ann.ok, true);
  assert.equal(ann.amount, 60);
  assert.equal(await ec.soldeDisponible(), 100);
  assert.equal(ec.engageDe('c1'), 0);
  assert.equal(ec.versement(v.versementId).refund.statut, REFUND_STATUT.CONFIRME);
});

test('double remboursement refusé : un seul crédit', async () => {
  const ledger = fakeLedger({ solde: 100 });
  const ec = createCagnottesEclats({ ledger, storage: fakeStorage(), uid });
  const v = await ec.verser('c1', 40);
  const a1 = await ec.annuler(v.versementId);
  const a2 = await ec.annuler(v.versementId);
  assert.equal(a1.ok, true);
  assert.equal(a2.ok, true);
  assert.equal(a2.idempotentReplay, true);
  assert.equal(await ec.soldeDisponible(), 100); // crédité une seule fois
  const refundMvts = ledger._mouvements().filter((m) => m.kind === 'refund');
  assert.equal(refundMvts.length, 1);
});

test('erreur réseau : non comptabilisée, rejouable', async () => {
  const ledger = fakeLedger({ solde: 100 });
  ledger.offline = true;
  const ec = createCagnottesEclats({ ledger, storage: fakeStorage(), uid });
  const r = await ec.verser('c1', 25);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'reseau');
  assert.equal(r.retryable, true);
  assert.equal(ec.engageDe('c1'), 0);
  assert.equal(ledger.debits, 0);
  // Le réseau revient : la reprise aboutit avec la même clé.
  ledger.offline = false;
  const r2 = await ec.reprendre(r.versementId);
  assert.equal(r2.ok, true);
  assert.equal(await ec.soldeDisponible(), 75);
  assert.equal(ledger.debits, 1);
});

test('rechargement après confirmation : pas de re-débit', async () => {
  const ledger = fakeLedger({ solde: 100 });
  const storage = fakeStorage();
  const ec1 = createCagnottesEclats({ ledger, storage, uid });
  const v = await ec1.verser('c1', 40);
  // Nouvelle instance (comme un rechargement de page), même stockage.
  const ec2 = createCagnottesEclats({ ledger, storage, uid });
  assert.equal(ec2.versement(v.versementId).statut, STATUT.CONFIRME);
  assert.equal(ec2.engageDe('c1'), 40);
  assert.equal(await ec2.soldeDisponible(), 60);
  assert.equal(ledger.debits, 1);
});

test('préservation des anciennes données locales de Cagnottes', async () => {
  const ancien = JSON.stringify({ version: 1, bourse: { solde: 12.5 }, cagnottes: [{ id: 'x' }] });
  const storage = fakeStorage({ cagnottes_app_state_v1: ancien });
  const ledger = fakeLedger({ solde: 100 });
  const ec = createCagnottesEclats({ ledger, storage, uid });
  await ec.verser('c1', 40);
  await ec.annuler((await ec.verser('c2', 10)).versementId);
  // Les données euro héritées ne sont jamais touchées ni converties.
  assert.equal(storage.getItem('cagnottes_app_state_v1'), ancien);
  assert.ok(storage.getItem(ETAT_STORAGE_KEY)); // le nouvel état vit dans sa propre clé
});
