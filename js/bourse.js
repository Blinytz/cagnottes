// La Bourse : le portefeuille en EUROS de Cagnottes.
//
// Elle n'est alimentée que d'une seule façon : en convertissant des Éclats du
// registre commun. Les cagnottes sont ensuite remplies depuis cette Bourse,
// en euros, sans jamais retoucher au registre commun — verser ne dépend donc
// pas du réseau.
//
//     Éclats communs ◀──▶ Bourse (€) ──▶ Cagnottes (€)
//
// Le taux est FIXE : 100 ✦ = 1 €, donc 1 Éclat = 1 centime. Il n'y a rien à
// arbitrer, rien à attendre, et la conversion est **réversible** : les euros
// non utilisés repartent en Éclats.
//
// Tout est compté en CENTIMES entiers : aucune dérive de flottant possible.
//
// Rendre des euros = DÉFAIRE une conversion
// -----------------------------------------
// Le registre commun ne sait pas créditer des Éclats, seulement rembourser une
// dépense passée (`eclats_refund`). C'est une garantie, pas une gêne : elle
// rend structurellement impossible qu'une application fabrique des Éclats. Une
// reprise porte donc sur une conversion entière, et seulement tant que la
// Bourse détient encore la somme correspondante — le reste étant engagé dans
// les cagnottes.
//
// Règles d'une conversion :
//   * elle DÉPENSE réellement des Éclats (`eclats_spend`, confirmée serveur) ;
//   * les euros crédités portent sur les Éclats RÉELLEMENT dépensés (le
//     registre plafonne au solde disponible) ;
//   * elle est idempotente : double clic, rejeu ou rechargement ne convertissent
//     jamais deux fois — et une reprise ne recrédite jamais deux fois.

export const APP_ID = 'cagnottes';
export const BOURSE_JOURNAL_KEY = 'cagnottes_bourse_v1';
export const CONVERSIONS_KEY = 'cagnottes_conversions_v1';

// 100 ✦ = 1 €. L'Éclat étant indivisible et l'euro compté en centimes, la
// parité est exactement 1 Éclat = 1 centime : aucune conversion à calculer.
export const ECLATS_PAR_EURO = 100;

export const centimesPour = (eclats) =>
  (Number.isFinite(eclats) && eclats > 0 ? Math.floor(eclats) : 0);

export const eclatsPour = (centimes) =>
  (Number.isFinite(centimes) && centimes > 0 ? Math.ceil(centimes) : 0);

export const CONVERSION_STATUT = {
  EN_ATTENTE: 'en_attente', // envoyée, pas encore confirmée
  CONFIRMEE: 'confirmee',   // Éclats débités, euros crédités
  REFUSEE: 'refusee',       // solde d'Éclats insuffisant — rien n'a bougé
  ERREUR: 'erreur',         // incident réseau — rien n'a bougé, rejouable
};

export const REPRISE_STATUT = {
  EN_ATTENTE: 'en_attente', // euros retirés de la Bourse, Éclats pas encore rendus
  CONFIRMEE: 'confirmee',   // Éclats rendus au registre commun
  ERREUR: 'erreur',         // incident réseau — rejouable, rien n'est perdu
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

export function createBourse({
  journal,          // registre local en centimes (createRegistreLocal)
  eclats,           // registre commun d'Éclats (createRegistre / createRegistreLocal)
  storage,
  uid = defaultUid,
  now = () => new Date().toISOString(),
} = {}) {
  if (!journal) throw new Error('Un journal (registre local en centimes) est requis.');
  if (!eclats) throw new Error("Un registre d'Éclats est requis.");

  const store = storage
    || (typeof globalThis !== 'undefined' && globalThis.localStorage) || memoryStorage();

  let enVol = false;   // garde anti double-clic

  function charger() {
    try {
      const parsed = JSON.parse(store.getItem(CONVERSIONS_KEY) || 'null');
      if (!parsed || typeof parsed.conversions !== 'object') return { conversions: {} };
      return parsed;
    } catch {
      return { conversions: {} };
    }
  }

  let etat = charger();
  function sauver() { store.setItem(CONVERSIONS_KEY, JSON.stringify(etat)); }

  const cleSpend = (id) => `cagnottes:conversion:${id}`;
  const cleCredit = (id) => `cagnottes:credit-conversion:${id}`;
  const cleRefund = (id) => `cagnottes:reprise-conversion:${id}`;
  const cleDebit = (id) => `cagnottes:debit-reprise:${id}`;

  // ---- Lecture ----

  /* Solde de la Bourse, en centimes. Synchrone : la Bourse est toujours locale,
     son journal est lisible immédiatement — l'interface se rend sans attendre. */
  function soldeCentimes() {
    return journal._etat().mouvements.reduce((s, m) => s + m.amount, 0);
  }

  function conversion(id) { return etat.conversions[id] || null; }
  function toutesConversions() {
    return Object.values(etat.conversions)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  function estConfirmee(c) { return c.statut === CONVERSION_STATUT.CONFIRMEE; }
  function estReprise(c) { return c.reprise?.statut === REPRISE_STATUT.CONFIRMEE; }

  /* Opérations non abouties : l'UI propose de les rejouer. */
  function enSouffrance() {
    return toutesConversions().filter((c) => c.statut === CONVERSION_STATUT.ERREUR
      || c.statut === CONVERSION_STATUT.EN_ATTENTE
      || c.reprise?.statut === REPRISE_STATUT.EN_ATTENTE
      || c.reprise?.statut === REPRISE_STATUT.ERREUR);
  }

  /*
   * Conversions qu'on peut défaire : confirmées, pas déjà reprises, et dont la
   * Bourse détient encore la somme. Le reste est engagé dans des cagnottes —
   * il faut d'abord annuler des versements pour le libérer.
   */
  function annulables() {
    const disponible = soldeCentimes();
    return toutesConversions()
      .filter((c) => estConfirmee(c) && !estReprise(c)
        && !c.reprise && c.centimes > 0 && c.centimes <= disponible);
  }

  /* Total des Éclats convertis et des euros obtenus, pour les statistiques. */
  function totaux() {
    const faites = toutesConversions().filter((c) => estConfirmee(c) && !estReprise(c));
    const reprises = toutesConversions().filter(estReprise);
    return {
      nb: faites.length,
      eclats: faites.reduce((s, c) => s + c.eclats, 0),
      centimes: faites.reduce((s, c) => s + c.centimes, 0),
      nbReprises: reprises.length,
      eclatsRendus: reprises.reduce((s, c) => s + c.eclats, 0),
    };
  }

  /* Aperçu, sans rien engager : ce que donnerait la conversion. */
  function simuler(eclatsDemandes) {
    const n = Math.floor(eclatsDemandes) || 0;
    return { eclats: n, centimes: centimesPour(n) };
  }

  // ---- Écriture : convertir des Éclats en euros ----

  async function envoyer(rec) {
    rec.statut = CONVERSION_STATUT.EN_ATTENTE;
    rec.erreur = null;
    sauver();
    try {
      // 1. Dépense réelle d'Éclats (plafonnée au solde par le registre).
      const dep = await eclats.depenser({
        appId: APP_ID,
        montant: rec.eclatsDemandes,
        reason: 'Conversion en euros',
        referenceType: 'conversion_euro',
        referenceId: rec.id,
        idempotencyKey: cleSpend(rec.id),
      });
      const eclatsDepenses = Number(dep.amount);

      // 2. Euros correspondants, sur les Éclats réellement dépensés.
      const centimes = centimesPour(eclatsDepenses);

      // 3. Crédit de la Bourse. Idempotent : un rejeu ne crédite pas deux fois.
      if (centimes > 0) {
        await journal.crediter({
          appId: APP_ID,
          montant: centimes,
          reason: `Conversion de ${eclatsDepenses} ✦`,
          referenceType: 'conversion_euro',
          referenceId: rec.id,
          idempotencyKey: cleCredit(rec.id),
          metadata: { eclats: eclatsDepenses },
        });
      }

      rec.statut = CONVERSION_STATUT.CONFIRMEE;
      rec.eclats = eclatsDepenses;
      rec.centimes = centimes;
      rec.ajuste = eclatsDepenses < rec.eclatsDemandes;
      rec.movementId = dep.movement_id;
      rec.confirmedAt = now();
      sauver();
      return {
        ok: true, conversionId: rec.id,
        eclats: eclatsDepenses, centimes, ajuste: rec.ajuste,
      };
    } catch (e) {
      const metier = /solde insuffisant/i.test(e.message || '');
      rec.statut = metier ? CONVERSION_STATUT.REFUSEE : CONVERSION_STATUT.ERREUR;
      rec.erreur = e.message || String(e);
      sauver();
      return {
        ok: false, conversionId: rec.id,
        reason: metier ? 'eclats_insuffisants' : 'reseau',
        retryable: !metier, message: rec.erreur,
      };
    }
  }

  async function convertir(eclatsDemandes) {
    const montant = Math.floor(eclatsDemandes);
    if (!Number.isFinite(montant) || montant <= 0) {
      return { ok: false, reason: 'montant_invalide' };
    }
    if (enVol) return { ok: false, reason: 'en_cours' };

    enVol = true;
    try {
      const id = uid();
      const rec = {
        id,
        eclatsDemandes: montant,
        eclats: 0,
        centimes: 0,
        statut: CONVERSION_STATUT.EN_ATTENTE,
        createdAt: now(),
        movementId: null,
        ajuste: false,
        reprise: null,
        erreur: null,
      };
      etat.conversions[id] = rec;
      sauver();
      return await envoyer(rec);
    } finally {
      enVol = false;
    }
  }

  /* Rejoue une conversion restée en attente ou en erreur. */
  async function reprendre(conversionId) {
    const rec = conversion(conversionId);
    if (!rec) return { ok: false, reason: 'introuvable' };
    if (estConfirmee(rec)) {
      return {
        ok: true, conversionId, eclats: rec.eclats, centimes: rec.centimes,
        idempotentReplay: true,
      };
    }
    if (enVol) return { ok: false, reason: 'en_cours' };
    enVol = true;
    try { return await envoyer(rec); }
    finally { enVol = false; }
  }

  // ---- Écriture : rendre des euros sous forme d'Éclats ----

  /*
   * Ordre volontaire : on retire d'abord les euros de la Bourse (local, sûr),
   * puis on rend les Éclats au registre (réseau, faillible). Si le réseau
   * lâche entre les deux, les euros sont « en transit » et l'opération est
   * rejouable — le remboursement étant idempotent, rejouer ne rend jamais deux
   * fois. L'ordre inverse aurait pu, lui, faire coexister les euros ET les
   * Éclats : de la valeur créée à partir de rien.
   */
  async function envoyerReprise(rec) {
    rec.reprise.statut = REPRISE_STATUT.EN_ATTENTE;
    rec.reprise.erreur = null;
    sauver();
    try {
      const res = await eclats.rembourser({
        appId: APP_ID,
        referenceType: 'conversion_euro',
        referenceId: rec.id,
        reason: 'Reprise : euros non utilisés rendus en Éclats',
        idempotencyKey: cleRefund(rec.id),
      });
      rec.reprise = {
        ...rec.reprise,
        statut: REPRISE_STATUT.CONFIRMEE,
        eclats: Number(res.amount),
        movementId: res.movement_id,
        confirmedAt: now(),
        erreur: null,
      };
      sauver();
      return { ok: true, conversionId: rec.id, eclats: rec.reprise.eclats, centimes: rec.centimes };
    } catch (e) {
      rec.reprise = {
        ...rec.reprise,
        statut: REPRISE_STATUT.ERREUR,
        erreur: e.message || String(e),
      };
      sauver();
      return {
        ok: false, conversionId: rec.id, reason: 'reseau',
        retryable: true, message: rec.reprise.erreur,
      };
    }
  }

  async function rendre(conversionId) {
    const rec = conversion(conversionId);
    if (!rec) return { ok: false, reason: 'introuvable' };
    if (!estConfirmee(rec)) return { ok: false, reason: 'non_comptabilisee' };
    if (estReprise(rec)) {
      return { ok: true, conversionId, eclats: rec.reprise.eclats, idempotentReplay: true };
    }
    if (enVol) return { ok: false, reason: 'en_cours' };

    // Reprise déjà entamée (euros retirés, Éclats pas encore rendus) : on
    // repart de l'étape réseau sans re-débiter la Bourse.
    if (rec.reprise) {
      enVol = true;
      try { return await envoyerReprise(rec); }
      finally { enVol = false; }
    }

    if (rec.centimes > soldeCentimes()) {
      return { ok: false, reason: 'euros_engages' };
    }

    enVol = true;
    try {
      const debit = await journal.depenser({
        appId: APP_ID,
        montant: rec.centimes,
        reason: 'Reprise en Éclats',
        referenceType: 'reprise_conversion',
        referenceId: rec.id,
        idempotencyKey: cleDebit(rec.id),
      });
      if (Number(debit.amount) < rec.centimes) {
        return { ok: false, reason: 'euros_engages' };
      }
      rec.reprise = { statut: REPRISE_STATUT.EN_ATTENTE, createdAt: now() };
      sauver();
      return await envoyerReprise(rec);
    } catch (e) {
      return { ok: false, reason: 'euros_engages', message: e.message || String(e) };
    } finally {
      enVol = false;
    }
  }

  return {
    CONVERSION_STATUT, REPRISE_STATUT, ECLATS_PAR_EURO,
    soldeCentimes, conversion, toutesConversions, annulables, enSouffrance, totaux,
    simuler, convertir, reprendre, rendre,
    _etat: () => etat,
    _recharger: () => { etat = charger(); return etat; },
    /*
     * Restauration d'une sauvegarde : les DEUX journaux doivent être remplacés
     * ensemble. Les euros (journal) et les conversions qui les ont produits
     * forment un tout — restaurer l'un sans l'autre laisserait un solde sans
     * origine, ou des conversions reprenables qui ne couvrent plus rien.
     */
    _journalEtat: () => journal._etat(),
    _remplacer: ({ conversions, journal: mouvements }) => {
      etat = (conversions && typeof conversions.conversions === 'object')
        ? conversions : { conversions: {} };
      sauver();
      journal._remplacer(mouvements);
    },
  };
}
