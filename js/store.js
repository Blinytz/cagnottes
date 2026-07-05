'use strict';

/*
 * Store : état global, persistance localStorage, et toute la logique métier
 * (Bourse, transferts, cagnottes, historiques journaliers).
 *
 * Architecture des mouvements de Bourse : chaque mouvement porte un champ
 * `source` ('manuel' pour l'instant). De futures intégrations (API, imports
 * automatiques…) pourront ajouter leurs propres valeurs de source sans
 * refonte : il suffira d'appeler Store.mouvementManuelBourse (ou une variante)
 * avec une autre source.
 */
const Store = (() => {

  const KEY = 'cagnottes_app_state_v1';
  const listeners = [];
  let state = null;

  /* ---------- État par défaut & persistance ---------- */

  function defaultState() {
    return {
      version: 1,
      bourse: {
        solde: 0,
        mouvements: [],           // { id, date, montant, type:'manuel'|'transfert_cagnotte', cagnotteId?, source, note? }
        historiqueJournalier: []  // { date:'YYYY-MM-DD', delta } — un point par jour
      },
      cagnottes: [],
      ordreManuel: false          // true dès que l'utilisateur a réordonné à la main
    };
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) { state = defaultState(); return; }
      const parsed = JSON.parse(raw);
      state = normalize(parsed);
    } catch (e) {
      console.error('État localStorage corrompu, réinitialisation :', e);
      state = defaultState();
      state._corrupted = true;
    }
  }

  /* Garantit la présence de tous les champs attendus (robustesse import/versions) */
  function normalize(s) {
    const d = defaultState();
    const out = Object.assign(d, s);
    out.bourse = Object.assign(d.bourse, s.bourse || {});
    out.bourse.solde = U.r2(Number(out.bourse.solde) || 0);
    out.bourse.mouvements = Array.isArray(out.bourse.mouvements) ? out.bourse.mouvements : [];
    out.bourse.historiqueJournalier = Array.isArray(out.bourse.historiqueJournalier) ? out.bourse.historiqueJournalier : [];
    out.cagnottes = (Array.isArray(s.cagnottes) ? s.cagnottes : []).map(c => ({
      id: c.id || U.uid(),
      nom: String(c.nom || 'Sans nom'),
      image: c.image && c.image.type ? c.image : { type: 'emoji', value: '🎁' },
      description: String(c.description || ''),
      objectif: Math.max(0.01, U.r2(Number(c.objectif) || 1)),
      montantActuel: Math.max(0, U.r2(Number(c.montantActuel) || 0)),
      palier: Math.max(0.01, U.r2(Number(c.palier) || 1)),
      statut: ['en_cours', 'en_attente_validation', 'archivée'].includes(c.statut) ? c.statut : 'en_cours',
      dateCreation: c.dateCreation || new Date().toISOString(),
      dateArchivage: c.dateArchivage || null,
      ordreAffichage: Number.isFinite(c.ordreAffichage) ? c.ordreAffichage : 0,
      historiqueJournalier: Array.isArray(c.historiqueJournalier) ? c.historiqueJournalier : [],
      mouvements: Array.isArray(c.mouvements) ? c.mouvements : []
    }));
    return out;
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
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

  /* ---------- Historique journalier (un point par jour = delta net) ---------- */

  function pushDelta(histo, delta) {
    const today = U.todayKey();
    const point = histo.find(p => p.date === today);
    if (point) point.delta = U.r2(point.delta + delta);
    else histo.push({ date: today, delta: U.r2(delta) });
  }

  /* ---------- Mouvements de Bourse ---------- */

  function addBourseMouvement(montant, type, { cagnotteId = null, note = '', source = 'manuel' } = {}) {
    state.bourse.solde = U.r2(state.bourse.solde + montant);
    state.bourse.mouvements.push({
      id: U.uid(),
      date: new Date().toISOString(),
      montant: U.r2(montant),
      type,
      cagnotteId,
      source,
      note: note || undefined
    });
    pushDelta(state.bourse.historiqueJournalier, montant);
  }

  /* Mouvement manuel direct sur la Bourse (positif ou négatif) */
  function mouvementManuelBourse(montant, note = '') {
    if (!Number.isFinite(montant) || montant === 0) return { ok: false, reason: 'montant_invalide' };
    addBourseMouvement(U.r2(montant), 'manuel', { note });
    notify();
    return { ok: true };
  }

  /* ---------- Transferts Bourse ↔ cagnotte ---------- */

  function majStatutApresMouvement(c) {
    if (c.statut === 'archivée') return;
    c.statut = (c.montantActuel >= c.objectif) ? 'en_attente_validation' : 'en_cours';
  }

  /*
   * Alimente une cagnotte depuis la Bourse.
   * - Bourse ≤ 0 → refus.
   * - Bourse < montant demandé → transfert partiel (la Bourse tombe à 0).
   */
  function alimenter(cagnotteId, montantDemande, note = '') {
    const c = getCagnotte(cagnotteId);
    if (!c) return { ok: false, reason: 'introuvable' };
    if (!Number.isFinite(montantDemande) || montantDemande <= 0) return { ok: false, reason: 'montant_invalide' };
    if (state.bourse.solde <= 0) return { ok: false, reason: 'bourse_vide' };

    const effectif = U.r2(Math.min(montantDemande, state.bourse.solde));
    addBourseMouvement(-effectif, 'transfert_cagnotte', { cagnotteId, note });
    c.montantActuel = U.r2(c.montantActuel + effectif);
    c.mouvements.push({ id: U.uid(), date: new Date().toISOString(), montant: effectif, note: note || undefined });
    pushDelta(c.historiqueJournalier, effectif);
    majStatutApresMouvement(c);
    notify();
    return { ok: true, effectif, ajuste: effectif < U.r2(montantDemande) };
  }

  /*
   * Retire d'une cagnotte (jamais sous 0 €) et reverse le montant à la Bourse.
   */
  function retirer(cagnotteId, montantDemande, note = '') {
    const c = getCagnotte(cagnotteId);
    if (!c) return { ok: false, reason: 'introuvable' };
    if (!Number.isFinite(montantDemande) || montantDemande <= 0) return { ok: false, reason: 'montant_invalide' };
    if (c.montantActuel <= 0) return { ok: false, reason: 'cagnotte_vide' };

    const effectif = U.r2(Math.min(montantDemande, c.montantActuel));
    c.montantActuel = U.r2(c.montantActuel - effectif);
    c.mouvements.push({ id: U.uid(), date: new Date().toISOString(), montant: -effectif, note: note || undefined });
    pushDelta(c.historiqueJournalier, -effectif);
    addBourseMouvement(effectif, 'transfert_cagnotte', { cagnotteId, note });
    majStatutApresMouvement(c);
    notify();
    return { ok: true, effectif, ajuste: effectif < U.r2(montantDemande) };
  }

  /* ---------- CRUD cagnottes ---------- */

  function getCagnotte(id) { return state.cagnottes.find(c => c.id === id); }

  function createCagnotte({ nom, image, objectif, palier, description = '' }) {
    const maxOrdre = state.cagnottes.reduce((m, c) => Math.max(m, c.ordreAffichage), 0);
    const c = {
      id: U.uid(),
      nom, image, description,
      objectif: U.r2(objectif),
      montantActuel: 0,
      palier: U.r2(palier),
      statut: 'en_cours',
      dateCreation: new Date().toISOString(),
      dateArchivage: null,
      ordreAffichage: maxOrdre + 1,
      historiqueJournalier: [],
      mouvements: []
    };
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

  /* Suppression : l'argent restant est reversé à la Bourse */
  function deleteCagnotte(id) {
    const c = getCagnotte(id);
    if (!c) return;
    if (c.montantActuel > 0 && c.statut !== 'archivée') {
      addBourseMouvement(c.montantActuel, 'transfert_cagnotte', {
        cagnotteId: id,
        note: `Suppression de la cagnotte « ${c.nom} »`
      });
    }
    state.cagnottes = state.cagnottes.filter(x => x.id !== id);
    notify();
  }

  /* Validation d'une cagnotte à 100 % : archivage (l'argent est « dépensé » pour la récompense) */
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

  function exportJSON() {
    return JSON.stringify({ app: 'cagnottes', exportDate: new Date().toISOString(), state }, null, 2);
  }

  function importJSON(text) {
    let parsed;
    try { parsed = JSON.parse(text); }
    catch { return { ok: false, reason: 'json_invalide' }; }
    const s = parsed.state || parsed; // accepte le fichier exporté ou l'état brut
    if (!s || typeof s !== 'object' || !s.bourse || !Array.isArray(s.cagnottes)) {
      return { ok: false, reason: 'structure_invalide' };
    }
    state = normalize(s);
    notify();
    return { ok: true };
  }

  function resetAll() {
    state = defaultState();
    notify();
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
        base = sorted.filter(p => p.date < winStart).reduce((s, p) => U.r2(s + p.delta), 0);
        startKey = winStart;
      }
    }
    const serie = [];
    let cur = base;
    let d = U.keyToDate(startKey);
    while (U.todayKey(d) <= today) {
      const k = U.todayKey(d);
      cur = U.r2(cur + (deltas.get(k) || 0));
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
    const jours = new Set(c.historiqueJournalier.map(p => p.date));
    if (jours.size < 3) return { type: 'pas_assez_de_donnees' };
    if (c.montantActuel >= c.objectif) return { type: 'atteint' };

    const debut = U.todayKey(U.addDays(new Date(), -13));
    const premierJour = [...jours].sort()[0];
    const fenetreDebut = premierJour > debut ? premierJour : debut;
    const nbJours = U.daysBetween(fenetreDebut, U.todayKey()) + 1;
    const somme = c.historiqueJournalier
      .filter(p => p.date >= fenetreDebut)
      .reduce((s, p) => s + p.delta, 0);
    const moyenne = somme / nbJours;

    if (moyenne <= 0) return { type: 'rythme_negatif' };
    const restant = c.objectif - c.montantActuel;
    return { type: 'ok', jours: Math.ceil(restant / moyenne), moyenne: U.r2(moyenne) };
  }

  /* ---------- Statistiques globales ---------- */

  function stats() {
    const all = state.cagnottes;
    const archivees = cagnottesArchivees();
    const enCours = all.filter(c => c.statut !== 'archivée');

    // Montant moyen cagnotté par jour (apports positifs / jours depuis 1er mouvement)
    let moyenneJour = null;
    const tousMouvements = all.flatMap(c => c.mouvements);
    if (tousMouvements.length) {
      const premier = tousMouvements.reduce((m, x) => x.date < m ? x.date : m, tousMouvements[0].date);
      const nbJours = Math.max(1, U.daysBetween(U.todayKey(new Date(premier)), U.todayKey()) + 1);
      const totalApports = tousMouvements.filter(m => m.montant > 0).reduce((s, m) => s + m.montant, 0);
      moyenneJour = U.r2(totalApports / nbJours);
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

    // Jour de la semaine le plus actif (≥ 7 apports pour être significatif)
    let meilleurJour = null;
    const apports = tousMouvements.filter(m => m.montant > 0);
    if (apports.length >= 7) {
      const parJour = [0, 0, 0, 0, 0, 0, 0];
      apports.forEach(m => { parJour[new Date(m.date).getDay()] += m.montant; });
      const idx = parJour.indexOf(Math.max(...parJour));
      meilleurJour = { jour: U.jourSemaine(idx), montant: U.r2(parJour[idx]) };
    }

    // Série d'évolution du total toutes cagnottes confondues
    const deltasFusionnes = new Map();
    all.forEach(c => c.historiqueJournalier.forEach(p => {
      deltasFusionnes.set(p.date, U.r2((deltasFusionnes.get(p.date) || 0) + p.delta));
    }));
    const histoGlobal = [...deltasFusionnes.entries()].map(([date, delta]) => ({ date, delta }));

    return {
      moyenneJour,
      tempsMoyenJours,
      nbCreees: all.length,
      nbArchivees: archivees.length,
      nbEnCours: enCours.length,
      totalEnCours: U.r2(enCours.reduce((s, c) => s + c.montantActuel, 0)),
      totalRecompense: U.r2(archivees.reduce((s, c) => s + c.objectif, 0)),
      plusRapide,
      meilleurJour,
      histoGlobal
    };
  }

  /* ---------- API publique ---------- */

  load();

  return {
    get state() { return state; },
    subscribe(fn) { listeners.push(fn); },
    getCagnotte, cagnottesEnCours, cagnottesArchivees,
    createCagnotte, updateCagnotte, deleteCagnotte,
    validerCagnotte, reactiverCagnotte,
    alimenter, retirer, mouvementManuelBourse,
    reordonner, resetOrdre,
    balanceSeries, estimation, stats,
    exportJSON, importJSON, resetAll
  };
})();
