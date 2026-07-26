// La Bourse : le portefeuille en EUROS de Cagnottes.
//
// Elle n'est alimentée que d'une seule façon : en convertissant des Éclats du
// registre commun, au taux du moment. Les cagnottes sont ensuite remplies
// depuis cette Bourse, en euros, sans jamais retoucher au registre commun.
//
//     Éclats communs ──(conversion au taux courant)──▶ Bourse (€) ──▶ Cagnottes (€)
//
// Tout est compté en CENTIMES entiers : aucune dérive de flottant possible.
//
// Règles d'une conversion :
//   * elle DÉPENSE réellement des Éclats (RPC `eclats_spend`, confirmée serveur) ;
//   * le taux est FIGÉ au moment de la demande — un rejeu après une panne réseau
//     applique le taux d'origine, jamais un taux devenu plus avantageux ;
//   * les euros crédités correspondent aux Éclats RÉELLEMENT dépensés (le
//     registre plafonne au solde disponible) ;
//   * elle est DÉFINITIVE : convertir bas puis annuler haut fabriquerait des
//     Éclats. Aucune annulation n'est donc proposée ;
//   * elle est idempotente : double clic, rejeu ou rechargement ne convertissent
//     jamais deux fois.

export const APP_ID = 'cagnottes';
export const BOURSE_JOURNAL_KEY = 'cagnottes_bourse_v1';
export const CONVERSIONS_KEY = 'cagnottes_conversions_v1';

export const CONVERSION_STATUT = {
  EN_ATTENTE: 'en_attente', // envoyée, pas encore confirmée
  CONFIRMEE: 'confirmee',   // Éclats débités, euros crédités
  REFUSEE: 'refusee',       // solde d'Éclats insuffisant — rien n'a bougé
  ERREUR: 'erreur',         // incident réseau — rien n'a bougé, rejouable
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
  taux,             // moteur de taux (createTaux)
  storage,
  uid = defaultUid,
  now = () => new Date().toISOString(),
} = {}) {
  if (!journal) throw new Error('Un journal (registre local en centimes) est requis.');
  if (!eclats) throw new Error("Un registre d'Éclats est requis.");
  if (!taux) throw new Error('Un moteur de taux est requis.');

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

  /* Conversions non abouties : l'UI propose de les rejouer. */
  function enSouffrance() {
    return toutesConversions().filter((c) => c.statut === CONVERSION_STATUT.ERREUR
      || c.statut === CONVERSION_STATUT.EN_ATTENTE);
  }

  /* Total des Éclats convertis et des euros obtenus, pour les statistiques. */
  function totaux() {
    const faites = toutesConversions().filter((c) => c.statut === CONVERSION_STATUT.CONFIRMEE);
    return {
      nb: faites.length,
      eclats: faites.reduce((s, c) => s + c.eclats, 0),
      centimes: faites.reduce((s, c) => s + c.centimes, 0),
    };
  }

  /* Aperçu, sans rien engager : ce que donnerait la conversion maintenant. */
  function simuler(eclatsDemandes) {
    const t = taux.actuel();
    return {
      taux: t,
      zone: taux.zone(),
      eclats: Math.floor(eclatsDemandes) || 0,
      centimes: taux.centimesPour(Math.floor(eclatsDemandes) || 0, t),
    };
  }

  // ---- Écriture ----

  async function envoyer(rec) {
    rec.statut = CONVERSION_STATUT.EN_ATTENTE;
    rec.erreur = null;
    sauver();
    try {
      // 1. Dépense réelle d'Éclats (plafonnée au solde par le registre).
      const dep = await eclats.depenser({
        appId: APP_ID,
        montant: rec.eclatsDemandes,
        reason: `Conversion en euros (taux ${rec.taux.toFixed(2)})`,
        referenceType: 'conversion_euro',
        referenceId: rec.id,
        idempotencyKey: cleSpend(rec.id),
        metadata: { taux: rec.taux },
      });
      const eclatsDepenses = Number(dep.amount);

      // 2. Euros correspondants, au taux FIGÉ à la demande, sur les Éclats
      //    réellement dépensés (jamais sur le montant demandé).
      const centimes = taux.centimesPour(eclatsDepenses, rec.taux);

      // 3. Crédit de la Bourse. Idempotent : un rejeu ne crédite pas deux fois.
      if (centimes > 0) {
        await journal.crediter({
          appId: APP_ID,
          montant: centimes,
          reason: `Conversion de ${eclatsDepenses} ✦ (taux ${rec.taux.toFixed(2)})`,
          referenceType: 'conversion_euro',
          referenceId: rec.id,
          idempotencyKey: cleCredit(rec.id),
          metadata: { taux: rec.taux, eclats: eclatsDepenses },
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
        eclats: eclatsDepenses, centimes, taux: rec.taux, ajuste: rec.ajuste,
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

  /*
   * Convertit des Éclats en euros au taux courant. Le taux est figé ici : c'est
   * celui qui s'appliquera même si la confirmation arrive plus tard.
   */
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
        taux: taux.actuel(),          // figé à la demande
        statut: CONVERSION_STATUT.EN_ATTENTE,
        createdAt: now(),
        movementId: null,
        ajuste: false,
        erreur: null,
      };
      etat.conversions[id] = rec;
      sauver();
      return await envoyer(rec);
    } finally {
      enVol = false;
    }
  }

  /* Rejoue une conversion restée en attente ou en erreur, au taux d'origine. */
  async function reprendre(conversionId) {
    const rec = conversion(conversionId);
    if (!rec) return { ok: false, reason: 'introuvable' };
    if (rec.statut === CONVERSION_STATUT.CONFIRMEE) {
      return {
        ok: true, conversionId, eclats: rec.eclats, centimes: rec.centimes,
        taux: rec.taux, idempotentReplay: true,
      };
    }
    if (enVol) return { ok: false, reason: 'en_cours' };
    enVol = true;
    try { return await envoyer(rec); }
    finally { enVol = false; }
  }

  return {
    CONVERSION_STATUT,
    soldeCentimes, conversion, toutesConversions, enSouffrance, totaux,
    simuler, convertir, reprendre,
    _etat: () => etat,
    _recharger: () => { etat = charger(); return etat; },
  };
}
