// La Bourse : le portefeuille en EUROS de Cagnottes.
//
// Elle n'est alimentée que d'une seule façon : en convertissant des Éclats du
// registre commun. Les cagnottes sont ensuite remplies depuis cette Bourse,
// en euros, sans jamais retoucher au registre commun — verser ne dépend donc
// pas du réseau.
//
//     Éclats communs ◀──▶ Bourse (€) ──▶ Cagnottes (€)
//
// Le taux est FIXE : 100 ✦ = 1 €, donc 1 Éclat = 1 centime. Rien à arbitrer,
// rien à attendre, et la conversion est réversible : **tout ou partie** du
// contenu de la Bourse peut repartir en Éclats.
//
// Tout est compté en CENTIMES entiers : aucune dérive de flottant possible.
//
// Seule la Bourse est reprenable
// ------------------------------
// Ce qui est déjà versé dans une cagnotte n'est pas repris : il faut d'abord
// l'en sortir (annuler un versement, ou supprimer la cagnotte, ce qui rend
// automatiquement ses euros à la Bourse). La reprise porte donc toujours sur le
// solde disponible, et sur lui seul.
//
// Comment un montant libre est possible
// -------------------------------------
// Le registre commun ne sait pas créditer des Éclats, seulement rembourser une
// dépense passée, et **en entier** (`eclats_refund`). C'est la garantie qui rend
// structurellement impossible qu'une application fabrique des Éclats.
//
// Pour rendre 20 € alors que la seule conversion passée en valait 50, on
// rembourse donc la conversion entière (+5 000 ✦) puis on en reconvertit
// aussitôt le reliquat (−3 000 ✦). Net : 2 000 ✦ rendus, 30 € conservés. Ce
// réancrage est interne ; l'utilisateur demande simplement un montant.
//
// Invariant maintenu : solde = Σ(conversions actives) − Σ(engagé en cagnottes).

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
  EN_COURS: 'en_cours',     // euros retirés, Éclats pas encore tous rendus
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
      if (!parsed || typeof parsed.conversions !== 'object') return { conversions: {}, reprises: {} };
      if (typeof parsed.reprises !== 'object' || !parsed.reprises) parsed.reprises = {};
      return parsed;
    } catch {
      return { conversions: {}, reprises: {} };
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

  /* Tout le solde disponible est reprenable — et rien de plus. */
  function maxRendable() { return Math.max(0, soldeCentimes()); }

  function conversion(id) { return etat.conversions[id] || null; }
  function toutesConversions() {
    return Object.values(etat.conversions)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }
  function reprise(id) { return etat.reprises[id] || null; }
  function toutesReprises() {
    return Object.values(etat.reprises)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  function estConfirmee(c) { return c.statut === CONVERSION_STATUT.CONFIRMEE; }

  /* Conversions encore actives : confirmées et pas encore consommées par une
     reprise. Ce sont elles qui « adossent » les euros en circulation. */
  function conversionsActives() {
    return toutesConversions().filter((c) => estConfirmee(c) && !c.repriseId);
  }

  /* Opérations non abouties : l'UI propose de les rejouer. */
  function enSouffrance() {
    return [
      ...toutesConversions().filter((c) => c.statut === CONVERSION_STATUT.ERREUR
        || c.statut === CONVERSION_STATUT.EN_ATTENTE),
      ...toutesReprises().filter((r) => r.statut !== REPRISE_STATUT.CONFIRMEE),
    ];
  }

  function totaux() {
    const actives = conversionsActives();
    const faites = toutesReprises().filter((r) => r.statut === REPRISE_STATUT.CONFIRMEE);
    return {
      nb: actives.length,
      eclats: actives.reduce((s, c) => s + c.eclats, 0),
      centimes: actives.reduce((s, c) => s + c.centimes, 0),
      nbReprises: faites.length,
      eclatsRendus: faites.reduce((s, r) => s + r.centimes, 0),
    };
  }

  /* Aperçu, sans rien engager. */
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
      const dep = await eclats.depenser({
        appId: APP_ID,
        montant: rec.eclatsDemandes,
        reason: 'Conversion en euros',
        referenceType: 'conversion_euro',
        referenceId: rec.id,
        idempotencyKey: cleSpend(rec.id),
      });
      const eclatsDepenses = Number(dep.amount);
      const centimes = centimesPour(eclatsDepenses);

      // Crédit de la Bourse. Idempotent : un rejeu ne crédite pas deux fois.
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
        repriseId: null,
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
   * Exécution d'une reprise, étape par étape et REPRENABLE : chaque étape est
   * idempotente et note son avancement, donc rejouer après une coupure ne
   * refait que ce qui manque.
   *
   * L'ordre est délibéré. Les euros quittent la Bourse EN PREMIER (local, sûr),
   * avant tout échange avec le registre. Toute interruption laisse donc
   * l'utilisateur avec moins que son dû — jamais avec plus, ce qui reviendrait
   * à créer de la valeur. C'est aussi pourquoi une reprise inachevée est
   * signalée et rejouée : elle se répare toujours vers le haut.
   */
  async function executer(rec) {
    rec.statut = REPRISE_STATUT.EN_COURS;
    rec.erreur = null;
    sauver();
    try {
      // 1. Retrait des euros de la Bourse.
      if (!rec.debitFait) {
        const debit = await journal.depenser({
          appId: APP_ID,
          montant: rec.centimes,
          reason: 'Reprise en Éclats',
          referenceType: 'reprise_euro',
          referenceId: rec.id,
          idempotencyKey: cleDebit(rec.id),
        });
        if (Number(debit.amount) < rec.centimes) throw new Error('Solde insuffisant');
        rec.debitFait = true;
        sauver();
      }

      // 2. Choix des conversions à défaire (les plus récentes d'abord), une
      //    seule fois : rejouer ne doit pas changer la cible.
      if (!rec.cibles) {
        const cibles = [];
        let somme = 0;
        for (const c of conversionsActives()) {
          if (somme >= rec.centimes) break;
          cibles.push(c.id);
          somme += c.centimes;
        }
        if (somme < rec.centimes) throw new Error('Conversions insuffisantes');
        rec.cibles = cibles;
        rec.somme = somme;
        rec.reliquat = somme - rec.centimes;
        rec.remboursees = [];
        sauver();
      }

      // 3. Remboursement de chaque conversion visée, en entier.
      for (const cid of rec.cibles) {
        if (rec.remboursees.includes(cid)) continue;
        await eclats.rembourser({
          appId: APP_ID,
          referenceType: 'conversion_euro',
          referenceId: cid,
          reason: 'Reprise : euros rendus en Éclats',
          idempotencyKey: cleRefund(cid),
        });
        rec.remboursees.push(cid);
        const c = conversion(cid);
        if (c) c.repriseId = rec.id;
        sauver();
      }

      // 4. Reconversion du reliquat : les euros conservés doivent rester
      //    adossés à des Éclats réellement dépensés. Pas de crédit en Bourse —
      //    ces euros n'en sont jamais sortis.
      if (rec.reliquat > 0 && !rec.reconversionId) {
        const id = uid();
        const dep = await eclats.depenser({
          appId: APP_ID,
          montant: rec.reliquat,
          reason: 'Reconversion du reliquat après reprise',
          referenceType: 'conversion_euro',
          referenceId: id,
          idempotencyKey: cleSpend(id),
        });
        etat.conversions[id] = {
          id,
          eclatsDemandes: rec.reliquat,
          eclats: Number(dep.amount),
          centimes: centimesPour(Number(dep.amount)),
          statut: CONVERSION_STATUT.CONFIRMEE,
          createdAt: now(),
          confirmedAt: now(),
          movementId: dep.movement_id,
          ajuste: false,
          repriseId: null,
          origine: 'reprise',
          erreur: null,
        };
        rec.reconversionId = id;
        sauver();
      }

      rec.statut = REPRISE_STATUT.CONFIRMEE;
      rec.confirmedAt = now();
      sauver();
      return { ok: true, repriseId: rec.id, centimes: rec.centimes, eclats: rec.centimes };
    } catch (e) {
      const message = e.message || String(e);
      // Avant tout retrait, un échec ne laisse aucune trace à réparer.
      if (!rec.debitFait) {
        delete etat.reprises[rec.id];
        sauver();
        return { ok: false, reason: /insuffisant/i.test(message) ? 'solde_insuffisant' : 'reseau', message };
      }
      rec.statut = REPRISE_STATUT.ERREUR;
      rec.erreur = message;
      sauver();
      return { ok: false, repriseId: rec.id, reason: 'reseau', retryable: true, message };
    }
  }

  /* Rend un montant libre, dans la limite du solde de la Bourse. */
  async function rendre(centimes) {
    const montant = Math.floor(centimes);
    if (!Number.isFinite(montant) || montant <= 0) {
      return { ok: false, reason: 'montant_invalide' };
    }
    if (montant > maxRendable()) return { ok: false, reason: 'solde_insuffisant' };
    if (enVol) return { ok: false, reason: 'en_cours' };

    enVol = true;
    try {
      const id = uid();
      etat.reprises[id] = {
        id,
        centimes: montant,
        statut: REPRISE_STATUT.EN_COURS,
        createdAt: now(),
        debitFait: false,
        cibles: null,
        somme: 0,
        reliquat: 0,
        remboursees: [],
        reconversionId: null,
        erreur: null,
      };
      sauver();
      return await executer(etat.reprises[id]);
    } finally {
      enVol = false;
    }
  }

  /* Rejoue une reprise interrompue. */
  async function reprendreReprise(repriseId) {
    const rec = reprise(repriseId);
    if (!rec) return { ok: false, reason: 'introuvable' };
    if (rec.statut === REPRISE_STATUT.CONFIRMEE) {
      return { ok: true, repriseId, centimes: rec.centimes, idempotentReplay: true };
    }
    if (enVol) return { ok: false, reason: 'en_cours' };
    enVol = true;
    try { return await executer(rec); }
    finally { enVol = false; }
  }

  /* Reprises inachevées, à rejouer (au démarrage notamment). */
  function reprisesInachevees() {
    return toutesReprises().filter((r) => r.statut !== REPRISE_STATUT.CONFIRMEE);
  }

  return {
    CONVERSION_STATUT, REPRISE_STATUT, ECLATS_PAR_EURO,
    soldeCentimes, maxRendable,
    conversion, toutesConversions, conversionsActives,
    reprise, toutesReprises, reprisesInachevees,
    enSouffrance, totaux, simuler,
    convertir, reprendre, rendre, reprendreReprise,
    _etat: () => etat,
    _recharger: () => { etat = charger(); return etat; },
    /*
     * Restauration d'une sauvegarde : les DEUX journaux doivent être remplacés
     * ensemble. Les euros (journal) et les conversions qui les ont produits
     * forment un tout — restaurer l'un sans l'autre laisserait un solde sans
     * origine, ou des euros reprenables qui ne sont plus adossés à rien.
     */
    _journalEtat: () => journal._etat(),
    _remplacer: ({ conversions, journal: mouvements }) => {
      etat = (conversions && typeof conversions.conversions === 'object')
        ? { conversions: conversions.conversions, reprises: conversions.reprises || {} }
        : { conversions: {}, reprises: {} };
      sauver();
      journal._remplacer(mouvements);
    },
  };
}
