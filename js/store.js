// Store : état des cagnottes, persistance localStorage, logique métier.
//
// Depuis la bascule du 25/07/2026, tout est compté en **Éclats** et la Bourse
// locale n'existe plus. Le solde disponible vient d'un registre d'Éclats
// (local aujourd'hui, le registre commun de l'écosystème demain — même
// contrat, voir `eclats-local.js` et `eclats-registre.js`).
//
// Répartition des responsabilités :
//   * ce module détient les données MÉTIER d'une cagnotte (nom, image,
//     objectif, palier, statut, ordre, dates) ;
//   * le journal des versements (`eclats-cagnottes.js`) est la SOURCE DE VÉRITÉ
//     comptable : le montant d'une cagnotte, ses mouvements et son historique
//     en sont dérivés, jamais recopiés. C'est ce qui permettra de brancher le
//     registre commun sans rien changer à l'interface.
//
// Les opérations d'argent sont donc asynchrones : elles ne sont acquises
// qu'une fois confirmées par le registre.

import {
  convertirEtatV1, etatInitial, estFormatEuro,
  VERSION_ECLATS, CLE_ETAT, CLE_SAUVEGARDE_EURO,
} from './eclats-migration.js';
import { LEDGER_STORAGE_KEY } from './eclats-local.js';

export function creerStore({ eclats, registre, onMigration = null }) {
  const listeners = [];
  let state = null;
  let soldeCache = 0;

  /* ---------- État par défaut & persistance ---------- */

  function defaultState() {
    return { version: VERSION_ECLATS, cagnottes: [], ordreManuel: false };
  }

  /*
   * Les valeurs comptables d'une cagnotte sont des vues sur le journal des
   * versements. Non énumérables : elles ne sont donc jamais persistées, ce qui
   * rend impossible toute divergence entre l'affichage et le registre.
   */
  function brancherDerivees(c) {
    const def = (nom, get) =>
      Object.defineProperty(c, nom, { get, enumerable: false, configurable: true });
    def('montantActuel', () => eclats.engageDe(c.id));
    def('mouvements', () => eclats.evenementsDe(c.id));
    def('historiqueJournalier', () => historiqueDe(c.id));
    return c;
  }

  function normaliserCagnotte(c, i = 0) {
    return brancherDerivees({
      id: c.id || U.uid(),
      nom: String(c.nom || 'Sans nom'),
      image: c.image && c.image.type ? c.image : { type: 'emoji', value: '🎁' },
      description: String(c.description || ''),
      objectif: Math.max(1, U.ent(c.objectif) || 1),
      palier: Math.max(1, U.ent(c.palier) || 1),
      statut: ['en_cours', 'en_attente_validation', 'archivée'].includes(c.statut) ? c.statut : 'en_cours',
      dateCreation: c.dateCreation || new Date().toISOString(),
      dateArchivage: c.dateArchivage || null,
      ordreAffichage: Number.isFinite(c.ordreAffichage) ? c.ordreAffichage : i + 1,
    });
  }

  /* Garantit la présence de tous les champs attendus (robustesse import/versions) */
  function normalize(s) {
    const d = defaultState();
    return {
      version: VERSION_ECLATS,
      ordreManuel: !!(s && s.ordreManuel),
      cagnottes: (Array.isArray(s && s.cagnottes) ? s.cagnottes : d.cagnottes)
        .map(normaliserCagnotte),
    };
  }

  function save() {
    try {
      localStorage.setItem(CLE_ETAT, JSON.stringify(state));
      return true;
    } catch (e) {
      console.error('Échec de sauvegarde localStorage :', e);
      if (typeof toast === 'function') {
        toast('⚠️ Stockage plein : la sauvegarde a échoué. Essaie une image plus légère ou exporte puis nettoie tes données.', 'error');
      }
      return false;
    }
  }

  function notify() {
    save();
    listeners.forEach(fn => fn(state));
  }

  /* ---------- Solde d'Éclats ---------- */

  /*
   * Le solde n'est jamais stocké côté client : il est lu du registre. On en
   * garde un cache pour le rendu synchrone, rafraîchi après chaque opération.
   */
  async function rafraichirSolde() {
    try { soldeCache = U.ent(await registre.solde()); }
    catch (e) { console.warn('Solde indisponible :', e); }
    return soldeCache;
  }

  function soldeDisponible() { return soldeCache; }

  /* Éclats immobilisés dans les cagnottes encore ouvertes */
  function totalEngage() {
    return state.cagnottes
      .filter(c => c.statut !== 'archivée')
      .reduce((s, c) => s + eclats.engageDe(c.id), 0);
  }

  /* Éclats déjà transformés en récompenses (cagnottes validées) */
  function totalRecompense() {
    return state.cagnottes
      .filter(c => c.statut === 'archivée')
      .reduce((s, c) => s + eclats.engageDe(c.id), 0);
  }

  /* ---------- Historique journalier (dérivé du journal) ---------- */

  function historiqueDe(cagnotteId) {
    const parJour = new Map();
    eclats.evenementsDe(cagnotteId).forEach(e => {
      const k = U.todayKey(new Date(e.date));
      parJour.set(k, U.ent((parJour.get(k) || 0) + e.montant));
    });
    return [...parJour.entries()]
      .map(([date, delta]) => ({ date, delta }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  /* ---------- Versements ---------- */

  function majStatutApresMouvement(c) {
    if (c.statut === 'archivée') return;
    c.statut = (c.montantActuel >= c.objectif) ? 'en_attente_validation' : 'en_cours';
  }

  /*
   * Alimente une cagnotte : consomme des Éclats disponibles. Le débit est
   * plafonné au solde et n'est acquis qu'après confirmation du registre.
   */
  async function alimenter(cagnotteId, montantDemande, note = '') {
    const c = getCagnotte(cagnotteId);
    if (!c) return { ok: false, reason: 'introuvable' };
    if (!Number.isFinite(montantDemande) || montantDemande <= 0) return { ok: false, reason: 'montant_invalide' };
    if (c.statut === 'archivée') return { ok: false, reason: 'archivee' };

    const res = await eclats.verser(cagnotteId, U.ent(montantDemande), note);
    await rafraichirSolde();
    if (!res.ok) { notify(); return res; }
    majStatutApresMouvement(c);
    notify();
    return { ok: true, effectif: res.amount, ajuste: !!res.adjusted, versementId: res.versementId };
  }

  /*
   * Retire des Éclats d'une cagnotte en annulant son dernier versement encore
   * engagé. Le registre rembourse par référence, en tout-ou-rien : on ne peut
   * pas retirer un montant arbitraire, seulement défaire un versement.
   */
  async function retirer(cagnotteId, note = '') {
    const c = getCagnotte(cagnotteId);
    if (!c) return { ok: false, reason: 'introuvable' };
    if (c.statut === 'archivée') return { ok: false, reason: 'archivee' };
    const dernier = eclats.dernierAnnulable(cagnotteId);
    if (!dernier) return { ok: false, reason: 'cagnotte_vide' };
    return annulerVersement(dernier.id, note ? `Retrait : ${note}` : 'Retrait de la cagnotte');
  }

  async function annulerVersement(versementId, motif = 'Annulation du versement') {
    const rec = eclats.versement(versementId);
    if (!rec) return { ok: false, reason: 'introuvable' };
    const c = getCagnotte(rec.cagnotteId);
    const res = await eclats.annuler(versementId, motif);
    await rafraichirSolde();
    if (!res.ok) { notify(); return res; }
    if (c) majStatutApresMouvement(c);
    notify();
    return { ok: true, effectif: res.amount };
  }

  /* Prochain montant retiré par le bouton « − » (null si rien à annuler) */
  function prochainRetrait(cagnotteId) {
    const v = eclats.dernierAnnulable(cagnotteId);
    return v ? v.amount : null;
  }

  /* ---------- CRUD cagnottes ---------- */

  function getCagnotte(id) { return state.cagnottes.find(c => c.id === id); }

  function createCagnotte({ nom, image, objectif, palier, description = '' }) {
    const maxOrdre = state.cagnottes.reduce((m, c) => Math.max(m, c.ordreAffichage), 0);
    const c = normaliserCagnotte({
      id: U.uid(), nom, image, description,
      objectif: U.ent(objectif),
      palier: U.ent(palier),
      statut: 'en_cours',
      dateCreation: new Date().toISOString(),
      dateArchivage: null,
      ordreAffichage: maxOrdre + 1,
    });
    state.cagnottes.push(c);
    notify();
    return c;
  }

  function updateCagnotte(id, champs) {
    const c = getCagnotte(id);
    if (!c) return;
    Object.assign(c, champs);
    if ('objectif' in champs) majStatutApresMouvement(c);
    notify();
  }

  /*
   * Suppression : les Éclats encore engagés sont rendus au registre (un
   * remboursement par versement). Si l'un d'eux échoue, on n'efface rien :
   * mieux vaut une cagnotte encore là qu'des Éclats perdus.
   */
  async function deleteCagnotte(id) {
    const c = getCagnotte(id);
    if (!c) return { ok: false, reason: 'introuvable' };

    let rendus = 0;
    if (c.statut !== 'archivée') {
      const aRembourser = eclats.annulablesDe(id);
      for (const v of aRembourser) {
        const res = await eclats.annuler(v.id, `Suppression de la cagnotte « ${c.nom} »`);
        if (!res.ok) {
          await rafraichirSolde();
          notify();
          return { ok: false, reason: 'remboursement_incomplet', rendus, message: res.message };
        }
        rendus += res.amount;
      }
      await rafraichirSolde();
    }

    state.cagnottes = state.cagnottes.filter(x => x.id !== id);
    notify();
    return { ok: true, rendus };
  }

  /*
   * Validation d'une cagnotte à 100 % : archivage. Aucune écriture comptable —
   * les Éclats ont déjà été dépensés au moment des versements ; la cagnotte
   * cesse simplement d'être annulable.
   */
  function validerCagnotte(id) {
    const c = getCagnotte(id);
    if (!c || c.montantActuel < c.objectif) return { ok: false };
    c.statut = 'archivée';
    c.dateArchivage = new Date().toISOString();
    notify();
    return { ok: true };
  }

  function reactiverCagnotte(id) {
    const c = getCagnotte(id);
    if (!c) return;
    c.statut = (c.montantActuel >= c.objectif) ? 'en_attente_validation' : 'en_cours';
    c.dateArchivage = null;
    notify();
  }

  /* ---------- Tri & réordonnancement ---------- */

  function cagnottesEnCours() {
    const actives = state.cagnottes.filter(c => c.statut !== 'archivée');
    if (state.ordreManuel) {
      return actives.sort((a, b) => a.ordreAffichage - b.ordreAffichage);
    }
    // Tri par défaut : % d'avancement décroissant
    return actives.sort((a, b) => (b.montantActuel / b.objectif) - (a.montantActuel / a.objectif));
  }

  function cagnottesArchivees() {
    return state.cagnottes
      .filter(c => c.statut === 'archivée')
      .sort((a, b) => new Date(b.dateArchivage) - new Date(a.dateArchivage));
  }

  /* Applique un nouvel ordre manuel (liste d'ids dans l'ordre d'affichage) */
  function reordonner(ids) {
    ids.forEach((id, i) => {
      const c = getCagnotte(id);
      if (c) c.ordreAffichage = i + 1;
    });
    state.ordreManuel = true;
    notify();
  }

  function resetOrdre() {
    state.ordreManuel = false;
    notify();
  }

  /* ---------- Export / import ---------- */

  /*
   * La sauvegarde embarque le journal des versements ET le journal d'Éclats :
   * sans eux, les versements ne seraient plus annulables (les clés
   * d'idempotence sont locales).
   */
  function exportJSON() {
    return JSON.stringify({
      app: 'cagnottes',
      exportDate: new Date().toISOString(),
      version: VERSION_ECLATS,
      unite: 'eclats',
      state,
      versements: eclats._etat().versements,
      ledger: registre.estLocal ? registre._etat() : null,
    }, null, 2);
  }

  function importJSON(text) {
    let parsed;
    try { parsed = JSON.parse(text); }
    catch { return { ok: false, reason: 'json_invalide' }; }

    const s = parsed.state || parsed;
    if (!s || typeof s !== 'object' || !Array.isArray(s.cagnottes)) {
      return { ok: false, reason: 'structure_invalide' };
    }

    // Sauvegarde antérieure à la bascule : convertie au même taux (1 € = 100 ✦).
    if (estFormatEuro(s)) {
      const conv = convertirEtatV1(s, { uid: U.uid });
      appliquer(conv);
      return { ok: true, converti: true, rapport: conv.rapport };
    }

    state = normalize(s);
    eclats.remplacerVersements(parsed.versements || {});
    if (registre.estLocal && parsed.ledger) {
      localStorage.setItem(LEDGER_STORAGE_KEY, JSON.stringify(parsed.ledger));
      registre._recharger();
    }
    notify();
    return { ok: true, converti: false };
  }

  function appliquer({ etat, versements, mouvements }) {
    state = normalize(etat);
    eclats.remplacerVersements(versements);
    if (registre.estLocal) {
      localStorage.removeItem(LEDGER_STORAGE_KEY);
      registre._recharger();
      (mouvements || []).forEach(m => registre._inserer(m));
    }
    notify();
  }

  function resetAll() {
    const frais = etatInitial();
    appliquer(frais);
    return frais.rapport;
  }

  /* ---------- Séries & estimations ---------- */

  /*
   * Transforme un historiqueJournalier (deltas) en série de soldes cumulés,
   * un point par jour calendaire, du début (ou du début de la fenêtre) à aujourd'hui.
   * rangeDays = null → depuis le début.
   */
  function balanceSeries(histo, rangeDays = null) {
    if (!histo.length) return [];
    const sorted = [...histo].sort((a, b) => a.date.localeCompare(b.date));
    const deltas = new Map(sorted.map(p => [p.date, p.delta]));
    const today = U.todayKey();
    let startKey = sorted[0].date;
    let base = 0;
    if (rangeDays) {
      const winStart = U.todayKey(U.addDays(new Date(), -(rangeDays - 1)));
      if (winStart > startKey) {
        // Solde accumulé avant la fenêtre
        base = sorted.filter(p => p.date < winStart).reduce((s, p) => U.ent(s + p.delta), 0);
        startKey = winStart;
      }
    }
    const serie = [];
    let cur = base;
    let d = U.keyToDate(startKey);
    while (U.todayKey(d) <= today) {
      const k = U.todayKey(d);
      cur = U.ent(cur + (deltas.get(k) || 0));
      serie.push({ date: k, value: cur });
      d = U.addDays(d, 1);
    }
    return serie;
  }

  /*
   * Estimation "objectif atteint dans X jours" à partir de la moyenne des
   * deltas journaliers sur les 14 derniers jours. Nécessite ≥ 3 jours de
   * données distincts.
   */
  function estimation(c) {
    const histo = c.historiqueJournalier;
    const jours = new Set(histo.map(p => p.date));
    if (jours.size < 3) return { type: 'pas_assez_de_donnees' };
    if (c.montantActuel >= c.objectif) return { type: 'atteint' };

    const debut = U.todayKey(U.addDays(new Date(), -13));
    const premierJour = [...jours].sort()[0];
    const fenetreDebut = premierJour > debut ? premierJour : debut;
    const nbJours = U.daysBetween(fenetreDebut, U.todayKey()) + 1;
    const somme = histo
      .filter(p => p.date >= fenetreDebut)
      .reduce((s, p) => s + p.delta, 0);
    const moyenne = somme / nbJours;

    if (moyenne <= 0) return { type: 'rythme_negatif' };
    const restant = c.objectif - c.montantActuel;
    return { type: 'ok', jours: Math.ceil(restant / moyenne), moyenne: U.ent(moyenne) };
  }

  /* ---------- Statistiques globales ---------- */

  function stats() {
    const all = state.cagnottes;
    const archivees = cagnottesArchivees();
    const enCours = all.filter(c => c.statut !== 'archivée');

    // Éclats moyens cagnottés par jour (versements / jours depuis le premier)
    let moyenneJour = null;
    const tousMouvements = all.flatMap(c => c.mouvements);
    if (tousMouvements.length) {
      const premier = tousMouvements.reduce((m, x) => x.date < m ? x.date : m, tousMouvements[0].date);
      const nbJours = Math.max(1, U.daysBetween(U.todayKey(new Date(premier)), U.todayKey()) + 1);
      const totalApports = tousMouvements.filter(m => m.montant > 0).reduce((s, m) => s + m.montant, 0);
      moyenneJour = U.ent(totalApports / nbJours);
    }

    // Temps moyen de clôture + cagnotte la plus rapide
    let tempsMoyenJours = null, plusRapide = null;
    if (archivees.length) {
      const durees = archivees.map(c => ({
        c,
        jours: Math.max(0, Math.round((new Date(c.dateArchivage) - new Date(c.dateCreation)) / 86400000))
      }));
      tempsMoyenJours = Math.round(durees.reduce((s, d) => s + d.jours, 0) / durees.length);
      plusRapide = durees.sort((a, b) => a.jours - b.jours)[0];
    }

    // Jour de la semaine le plus actif (≥ 7 versements pour être significatif)
    let meilleurJour = null;
    const apports = tousMouvements.filter(m => m.montant > 0);
    if (apports.length >= 7) {
      const parJour = [0, 0, 0, 0, 0, 0, 0];
      apports.forEach(m => { parJour[new Date(m.date).getDay()] += m.montant; });
      const idx = parJour.indexOf(Math.max(...parJour));
      meilleurJour = { jour: U.jourSemaine(idx), montant: U.ent(parJour[idx]) };
    }

    // Série d'évolution du total toutes cagnottes confondues
    const deltasFusionnes = new Map();
    all.forEach(c => c.historiqueJournalier.forEach(p => {
      deltasFusionnes.set(p.date, U.ent((deltasFusionnes.get(p.date) || 0) + p.delta));
    }));
    const histoGlobal = [...deltasFusionnes.entries()].map(([date, delta]) => ({ date, delta }));

    return {
      moyenneJour,
      tempsMoyenJours,
      nbCreees: all.length,
      nbArchivees: archivees.length,
      nbEnCours: enCours.length,
      totalEnCours: totalEngage(),
      totalRecompense: totalRecompense(),
      plusRapide,
      meilleurJour,
      histoGlobal
    };
  }

  /* ---------- Chargement initial & bascule euro → Éclats ---------- */

  function charger() {
    let brut = null;
    try { brut = JSON.parse(localStorage.getItem(CLE_ETAT) || 'null'); }
    catch (e) {
      console.error('État localStorage corrompu, réinitialisation :', e);
      const frais = etatInitial();
      appliquer(frais);
      state._corrupted = true;
      return;
    }

    if (!brut) {
      // Installation neuve : pas de conversion, juste le solde d'ouverture.
      const frais = etatInitial();
      state = normalize(frais.etat);
      if (registre.estLocal && !registre._etat().mouvements.length) {
        frais.mouvements.forEach(m => registre._inserer(m));
      }
      save();
      return;
    }

    if (estFormatEuro(brut)) {
      // Bascule : la copie euro d'origine est conservée avant toute écriture.
      try { localStorage.setItem(CLE_SAUVEGARDE_EURO, JSON.stringify(brut)); }
      catch (e) { console.warn('Copie de sauvegarde euro impossible :', e); }
      const conv = convertirEtatV1(brut, { uid: U.uid });
      appliquer(conv);
      if (onMigration) onMigration(conv.rapport, brut);
      return;
    }

    state = normalize(brut);
  }

  /* ---------- API publique ---------- */

  charger();

  return {
    get state() { return state; },
    subscribe(fn) { listeners.push(fn); },
    getCagnotte, cagnottesEnCours, cagnottesArchivees,
    createCagnotte, updateCagnotte, deleteCagnotte,
    validerCagnotte, reactiverCagnotte,
    alimenter, retirer, annulerVersement, prochainRetrait,
    soldeDisponible, rafraichirSolde, totalEngage, totalRecompense,
    reordonner, resetOrdre,
    balanceSeries, estimation, stats,
    exportJSON, importJSON, resetAll,
    eclats, registre,
  };
}
