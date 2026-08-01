// Registre d'Éclats LOCAL — phase de transition.
//
// Implémente EXACTEMENT le même contrat que `eclats-registre.js` (le client du
// registre commun Supabase) : mêmes signatures, mêmes retours, mêmes messages
// d'erreur, mêmes garanties d'idempotence. Le contrôleur `eclats-cagnottes.js`
// ne fait donc aucune différence entre les deux, et la bascule vers le registre
// commun consistera à échanger cet objet contre `createRegistre()` — sans
// toucher ni au contrôleur ni à l'interface.
//
// Sémantique reproduite depuis `apps/pronos/sql/registre_commun.sql` :
//   * le solde n'est jamais stocké : il est la somme du journal ;
//   * une dépense est plafonnée au solde disponible ;
//   * une clé d'idempotence rejouée ne re-débite jamais ;
//   * un remboursement est exactement-une-fois par référence métier ;
//   * aucune écriture n'est supprimée : une correction est compensatoire.
//
// Les montants sont des entiers : l'Éclat est indivisible.

export const LEDGER_STORAGE_KEY = 'cagnottes_eclats_local_v1';

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

function defaultUid() {
  return (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const ent = (v) => Math.round(Number(v) || 0);

export function createRegistreLocal({
  storage,
  uid = defaultUid,
  now = () => new Date().toISOString(),
  cle = LEDGER_STORAGE_KEY,
} = {}) {
  const store = storage
    || (typeof globalThis !== 'undefined' && globalThis.localStorage) || memoryStorage();

  function charger() {
    try {
      const parsed = JSON.parse(store.getItem(cle) || 'null');
      if (!parsed || !Array.isArray(parsed.mouvements)) return { version: 1, mouvements: [] };
      return parsed;
    } catch {
      return { version: 1, mouvements: [] };
    }
  }

  let etat = charger();
  function sauver() { store.setItem(cle, JSON.stringify(etat)); }

  function total() {
    return etat.mouvements.reduce((s, m) => s + m.amount, 0);
  }

  /* `k` et non `cle` : ne pas masquer la clé de stockage de la fabrique. */
  function parCle(k) {
    return etat.mouvements.find((m) => m.idempotency_key === k) || null;
  }

  // Écriture brute dans le journal. Idempotente par clé : une clé déjà présente
  // renvoie le mouvement existant sans rien réécrire.
  function inserer({
    amount, appId, kind, reason, referenceType, referenceId,
    idempotencyKey, occurredAt, metadata = null,
  }) {
    const existant = parCle(idempotencyKey);
    if (existant) return existant;
    const mouvement = {
      id: uid(),
      amount: ent(amount),
      app_id: appId,
      kind,
      reason: reason ?? null,
      reference_type: referenceType ?? null,
      reference_id: referenceId ?? null,
      idempotency_key: idempotencyKey,
      occurred_at: occurredAt || now(),
      metadata,
    };
    etat.mouvements.push(mouvement);
    sauver();
    return mouvement;
  }

  // ---- Contrat commun avec eclats-registre.js ----

  async function solde() { return total(); }

  async function depenser({
    appId, montant, reason, referenceType, referenceId, idempotencyKey, metadata,
  }) {
    if (!appId) throw new Error('app_id requis');
    if (!Number.isFinite(montant) || montant <= 0) throw new Error('Montant invalide');
    if (!idempotencyKey || idempotencyKey.length < 8) throw new Error("Clé d'idempotence invalide");

    const existant = parCle(idempotencyKey);
    if (existant) {
      return {
        movement_id: existant.id,
        amount: -existant.amount,          // consommé réel (positif)
        requested: montant,
        adjusted: -existant.amount < montant,
        balance_after: total(),
        idempotent_replay: true,
      };
    }

    const disponible = Math.max(total(), 0);
    const consomme = Math.min(ent(montant), disponible);
    if (consomme <= 0) throw new Error('Solde insuffisant : aucun Éclat disponible');

    const mouvement = inserer({
      amount: -consomme, appId, kind: 'spend', reason,
      referenceType, referenceId, idempotencyKey, metadata,
    });
    return {
      movement_id: mouvement.id,
      amount: consomme,
      requested: montant,
      adjusted: consomme < ent(montant),
      balance_after: total(),
      idempotent_replay: false,
    };
  }

  async function rembourser({
    appId, referenceType, referenceId, reason, idempotencyKey, metadata,
  }) {
    if (!idempotencyKey || idempotencyKey.length < 8) throw new Error("Clé d'idempotence invalide");

    const existant = parCle(idempotencyKey);
    if (existant) {
      return {
        movement_id: existant.id,
        amount: existant.amount,
        balance_after: total(),
        idempotent_replay: true,
      };
    }

    const memeReference = (m) => m.app_id === appId
      && m.reference_type === referenceType && m.reference_id === referenceId;

    // Dépense nette réellement engagée pour cette référence.
    const depense = -etat.mouvements
      .filter((m) => memeReference(m) && ['spend', 'adjustment'].includes(m.kind) && m.amount < 0)
      .reduce((s, m) => s + m.amount, 0);
    if (depense <= 0) throw new Error('Aucune dépense à rembourser pour cette référence');

    const dejaRembourse = etat.mouvements
      .filter((m) => memeReference(m) && m.kind === 'refund')
      .reduce((s, m) => s + m.amount, 0);
    const montant = depense - dejaRembourse;
    if (montant <= 0) throw new Error('Dépense déjà remboursée');

    const mouvement = inserer({
      amount: montant, appId, kind: 'refund', reason,
      referenceType, referenceId, idempotencyKey, metadata,
    });
    return {
      movement_id: mouvement.id,
      amount: montant,
      balance_after: total(),
      idempotent_replay: false,
    };
  }

  // Crédit (entrée de valeur). Symétrique de `depenser`, idempotent par clé :
  // rejouer la même clé ne crédite jamais deux fois. Utilisé par la Bourse en
  // euros, alimentée par les conversions d'Éclats.
  async function crediter({
    appId, montant, reason, referenceType, referenceId, idempotencyKey, metadata,
  }) {
    if (!appId) throw new Error('app_id requis');
    if (!Number.isFinite(montant) || montant <= 0) throw new Error('Montant invalide');
    if (!idempotencyKey || idempotencyKey.length < 8) throw new Error("Clé d'idempotence invalide");

    const existant = parCle(idempotencyKey);
    if (existant) {
      return {
        movement_id: existant.id,
        amount: existant.amount,
        balance_after: total(),
        idempotent_replay: true,
      };
    }

    const mouvement = inserer({
      amount: ent(montant), appId, kind: 'reward', reason,
      referenceType, referenceId, idempotencyKey, metadata,
    });
    return {
      movement_id: mouvement.id,
      amount: mouvement.amount,
      balance_after: total(),
      idempotent_replay: false,
    };
  }

  // Agrégats par application — même forme que la RPC eclats_aggregates_by_app.
  async function agregatsParApp() {
    const parApp = new Map();
    etat.mouvements.forEach((m) => {
      const a = parApp.get(m.app_id) || {
        app_id: m.app_id, balance: 0, movements: 0, spent: 0, gained: 0, last_at: null,
      };
      a.balance += m.amount;
      a.movements += 1;
      if (m.amount < 0) a.spent += -m.amount;
      else a.gained += m.amount;
      if (!a.last_at || m.occurred_at > a.last_at) a.last_at = m.occurred_at;
      parApp.set(m.app_id, a);
    });
    return [...parApp.values()];
  }

  async function mouvements({ limit = 50, appId } = {}) {
    return etat.mouvements
      .filter((m) => !appId || m.app_id === appId)
      .sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at)))
      .slice(0, limit);
  }

  // Le registre local n'a pas de session : il est toujours « joignable ».
  function estConnecte() { return true; }
  function utilisateur() { return null; }

  return {
    estLocal: true,
    estConnecte, utilisateur,
    solde, depenser, rembourser, crediter, agregatsParApp, mouvements,
    // Écriture directe, réservée à la migration (rejeu d'un historique daté).
    _inserer: inserer,
    _etat: () => etat,
    _recharger: () => { etat = charger(); return etat; },
    /* Remplace le journal entier (restauration d'une sauvegarde). */
    _remplacer: (nouvel) => {
      etat = (nouvel && Array.isArray(nouvel.mouvements)) ? nouvel : { version: 1, mouvements: [] };
      sauver();
      return etat;
    },
  };
}
