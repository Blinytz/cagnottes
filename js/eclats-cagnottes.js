// Contrôleur Éclats de Cagnottes.
//
// Fait le pont entre les cagnottes (données métier LOCALES : nom, objectif,
// icône, ordre — jamais touchées ici) et le registre commun d'Éclats.
//
// Règles (relais Phase 3) :
//   * un versement consomme des Éclats communs, plafonné au solde disponible ;
//   * le débit n'est « comptabilisé » qu'après confirmation serveur ;
//   * annuler/supprimer un versement rembourse EXACTEMENT le mouvement d'origine ;
//   * un remboursement ne peut être fait qu'une seule fois ;
//   * aucune conversion euro→Éclat automatique ;
//   * une opération est toujours dans un état clair : en attente / confirmée / erreur.
//
// L'idempotence réseau (double clic réseau, rejeu, rechargement) repose sur des
// clés STABLES dérivées de l'id du versement. Une garde « en cours » par cagnotte
// évite qu'un double clic ne crée deux versements distincts.

export const APP_ID = 'cagnottes';
export const ETAT_STORAGE_KEY = 'cagnottes_eclats_v1';

export const STATUT = {
  EN_ATTENTE: 'en_attente', // envoyé, pas encore confirmé (ou repris)
  CONFIRME: 'confirme',     // débit confirmé par le serveur
  REFUSE: 'refuse',         // refus métier (ex. solde insuffisant) — non comptabilisé
  ERREUR: 'erreur',         // erreur réseau — non comptabilisé, rejouable
};

export const REFUND_STATUT = {
  EN_ATTENTE: 'en_attente',
  CONFIRME: 'confirme',
  ERREUR: 'erreur',
};

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

export function createCagnottesEclats({
  ledger,
  storage,
  uid = defaultUid,
  now = () => new Date().toISOString(),
} = {}) {
  if (!ledger) throw new Error('Un client de registre (ledger) est requis.');
  const store = storage
    || (typeof globalThis !== 'undefined' && globalThis.localStorage) || memoryStorage();

  const enCours = new Set(); // cagnotteId avec un versement en vol (garde double clic)

  function charger() {
    try {
      const raw = store.getItem(ETAT_STORAGE_KEY);
      if (!raw) return { versements: {} };
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || typeof parsed.versements !== 'object') {
        return { versements: {} };
      }
      return parsed;
    } catch {
      return { versements: {} };
    }
  }

  let etat = charger();
  function sauver() { store.setItem(ETAT_STORAGE_KEY, JSON.stringify(etat)); }

  function cleSpend(id) { return `cagnottes:versement:${id}`; }
  function cleRefund(id) { return `cagnottes:remboursement:${id}`; }

  // ---- Lecture ----

  function versement(id) { return etat.versements[id] || null; }
  function tousVersements() { return Object.values(etat.versements); }
  function versementsDe(cagnotteId) {
    return tousVersements().filter((v) => v.cagnotteId === cagnotteId);
  }

  // Éclats réellement engagés dans une cagnotte = versements confirmés non
  // remboursés (le remboursement confirmé annule l'engagement).
  function engageDe(cagnotteId) {
    return versementsDe(cagnotteId)
      .filter((v) => v.statut === STATUT.CONFIRME
        && v.refund?.statut !== REFUND_STATUT.CONFIRME)
      .reduce((s, v) => s + v.amount, 0);
  }

  function engageTotal() {
    return tousVersements()
      .filter((v) => v.statut === STATUT.CONFIRME
        && v.refund?.statut !== REFUND_STATUT.CONFIRME)
      .reduce((s, v) => s + v.amount, 0);
  }

  function soldeDisponible() { return ledger.solde(); }

  // Versements encore engagés dans une cagnotte, du plus ancien au plus récent.
  // Ce sont les seuls annulables : le registre rembourse par référence, en
  // tout-ou-rien.
  function annulablesDe(cagnotteId) {
    return versementsDe(cagnotteId)
      .filter((v) => v.statut === STATUT.CONFIRME
        && v.refund?.statut !== REFUND_STATUT.CONFIRME)
      .sort((a, b) => String(a.confirmedAt || a.createdAt)
        .localeCompare(String(b.confirmedAt || b.createdAt)));
  }

  // Dernier versement annulable — cible du bouton « − ».
  function dernierAnnulable(cagnotteId) {
    const liste = annulablesDe(cagnotteId);
    return liste.length ? liste[liste.length - 1] : null;
  }

  /*
   * Événements comptables d'une cagnotte, à plat et datés : un versement
   * confirmé (positif) et, s'il a été annulé, son remboursement (négatif).
   * Sert à dériver l'historique et la liste affichée — le journal des
   * versements étant la source de vérité, rien n'est stocké en double.
   */
  function evenementsDe(cagnotteId) {
    const evts = [];
    versementsDe(cagnotteId).forEach((v) => {
      if (v.statut !== STATUT.CONFIRME) return;
      evts.push({
        date: v.confirmedAt || v.createdAt,
        montant: v.amount,
        note: v.note,
        versementId: v.id,
        type: 'versement',
        annulable: v.refund?.statut !== REFUND_STATUT.CONFIRME,
      });
      if (v.refund?.statut === REFUND_STATUT.CONFIRME) {
        evts.push({
          date: v.refund.confirmedAt,
          montant: -v.refund.amount,
          note: v.refund.motif,
          versementId: v.id,
          type: 'annulation',
          annulable: false,
        });
      }
    });
    return evts.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  }

  // Versements non comptabilisés (réseau/refus) : l'UI propose de les rejouer.
  function enSouffrance() {
    return tousVersements().filter((v) => v.statut === STATUT.ERREUR
      || v.statut === STATUT.EN_ATTENTE
      || v.refund?.statut === REFUND_STATUT.ERREUR);
  }

  // ---- Écriture : versement ----

  async function envoyerSpend(rec) {
    rec.statut = STATUT.EN_ATTENTE;
    rec.erreur = null;
    sauver();
    try {
      const res = await ledger.depenser({
        appId: APP_ID,
        montant: rec.requested,
        reason: rec.reason,
        referenceType: 'cagnotte_versement',
        referenceId: rec.id,
        idempotencyKey: cleSpend(rec.id),
        metadata: { cagnotteId: rec.cagnotteId },
      });
      rec.statut = STATUT.CONFIRME;
      rec.amount = Number(res.amount);
      rec.movementId = res.movement_id;
      rec.adjusted = !!res.adjusted;
      rec.idempotentReplay = !!res.idempotent_replay;
      rec.confirmedAt = now();
      sauver();
      return {
        ok: true, versementId: rec.id, amount: rec.amount,
        adjusted: rec.adjusted, idempotentReplay: rec.idempotentReplay,
      };
    } catch (e) {
      // Refus métier (solde insuffisant) vs erreur réseau/technique.
      const metier = /solde insuffisant/i.test(e.message || '');
      rec.statut = metier ? STATUT.REFUSE : STATUT.ERREUR;
      rec.erreur = e.message || String(e);
      sauver();
      return {
        ok: false, versementId: rec.id,
        reason: metier ? 'solde_insuffisant' : 'reseau',
        retryable: !metier, message: rec.erreur,
      };
    }
  }

  // Nouveau versement (crée le brouillon puis l'envoie). Garde « en cours »
  // par cagnotte : un second appel concurrent est refusé sans créer de doublon.
  async function verser(cagnotteId, montantDemande, note = '') {
    if (!cagnotteId) return { ok: false, reason: 'cagnotte_invalide' };
    if (!Number.isFinite(montantDemande) || montantDemande <= 0) {
      return { ok: false, reason: 'montant_invalide' };
    }
    if (enCours.has(cagnotteId)) return { ok: false, reason: 'en_cours' };

    enCours.add(cagnotteId);
    try {
      const id = uid();
      const rec = {
        id, cagnotteId,
        requested: montantDemande,
        amount: 0,
        reason: 'Versement dans une cagnotte',
        note: note || undefined,
        statut: STATUT.EN_ATTENTE,
        createdAt: now(),
        movementId: null,
        adjusted: false,
        refund: null,
        erreur: null,
      };
      etat.versements[id] = rec;
      sauver();
      return await envoyerSpend(rec);
    } finally {
      enCours.delete(cagnotteId);
    }
  }

  // Réémission d'un versement en attente/erreur avec la MÊME clé (idempotent :
  // ne re-débite jamais, même si le premier envoi avait en réalité abouti).
  async function reprendre(versementId) {
    const rec = versement(versementId);
    if (!rec) return { ok: false, reason: 'introuvable' };
    if (rec.statut === STATUT.CONFIRME) {
      return { ok: true, versementId, amount: rec.amount, idempotentReplay: true };
    }
    if (enCours.has(rec.cagnotteId)) return { ok: false, reason: 'en_cours' };
    enCours.add(rec.cagnotteId);
    try { return await envoyerSpend(rec); }
    finally { enCours.delete(rec.cagnotteId); }
  }

  // ---- Écriture : remboursement (annulation/suppression) ----

  async function annuler(versementId, motif = 'Annulation du versement') {
    const rec = versement(versementId);
    if (!rec) return { ok: false, reason: 'introuvable' };
    if (rec.statut !== STATUT.CONFIRME) {
      // Rien n'a été comptabilisé : pas de remboursement à faire.
      return { ok: false, reason: 'non_comptabilise' };
    }
    if (rec.refund?.statut === REFUND_STATUT.CONFIRME) {
      return { ok: true, versementId, amount: rec.refund.amount, idempotentReplay: true };
    }

    rec.refund = { statut: REFUND_STATUT.EN_ATTENTE, idempotencyKey: cleRefund(rec.id) };
    sauver();
    try {
      const res = await ledger.rembourser({
        appId: APP_ID,
        referenceType: 'cagnotte_versement',
        referenceId: rec.id,
        reason: motif,
        idempotencyKey: cleRefund(rec.id),
        metadata: { cagnotteId: rec.cagnotteId },
      });
      rec.refund = {
        statut: REFUND_STATUT.CONFIRME,
        amount: Number(res.amount),
        movementId: res.movement_id,
        idempotentReplay: !!res.idempotent_replay,
        confirmedAt: now(),
      };
      sauver();
      return {
        ok: true, versementId, amount: rec.refund.amount,
        idempotentReplay: rec.refund.idempotentReplay,
      };
    } catch (e) {
      rec.refund = {
        statut: REFUND_STATUT.ERREUR,
        idempotencyKey: cleRefund(rec.id),
        erreur: e.message || String(e),
      };
      sauver();
      return { ok: false, versementId, reason: 'reseau', retryable: true, message: rec.refund.erreur };
    }
  }

  // Remplace le journal (bascule euro → Éclats, import d'une sauvegarde).
  function remplacerVersements(versements) {
    etat = { versements: versements && typeof versements === 'object' ? versements : {} };
    sauver();
    return etat;
  }

  return {
    STATUT, REFUND_STATUT, APP_ID,
    verser, reprendre, annuler,
    versement, tousVersements, versementsDe,
    annulablesDe, dernierAnnulable, evenementsDe, enSouffrance,
    engageDe, engageTotal, soldeDisponible,
    remplacerVersements,
    _etat: () => etat,
    _recharger: () => { etat = charger(); return etat; },
  };
}
