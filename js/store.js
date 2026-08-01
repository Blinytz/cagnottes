// Store : état des cagnottes, persistance localStorage, logique métier.
//
// Cagnottes compte en **EUROS** (en centimes entiers). Les Éclats restent la
// monnaie de l'écosystème : ils n'entrent dans Cagnottes que par une CONVERSION
// explicite, au taux fixe 100 ✦ = 1 €, qui alimente la **Bourse**
// (voir `bourse.js`). La conversion est réversible.
//
//     Éclats communs ◀──▶ Bourse (€) ──▶ Cagnottes (€)
//
// Répartition des responsabilités :
//   * ce module détient les données MÉTIER d'une cagnotte (nom, image,
//     objectif, palier, statut, ordre, dates) ;
//   * le journal des versements (`eclats-cagnottes.js`, branché sur la Bourse)
//     est la SOURCE DE VÉRITÉ comptable : le montant d'une cagnotte, ses
//     mouvements et son historique en sont dérivés, jamais recopiés.
//
// Les versements ne dépendent plus du réseau : la Bourse est locale. Seule la
// conversion d'Éclats parle au registre commun.

import {
  VERSION_EUROS, CLE_SAUVEGARDE_ECLATS,
  estFormatEclats, convertirEtatEnEuros, etatInitialEuros, planRemboursement,
} from './bascule-euros.js';

export const CLE_ETAT = 'cagnottes_app_state_v1';

export function creerStore({
  versements,        // contrôleur de versements, branché sur la Bourse (centimes)
  bourse,            // Bourse en euros
  ancienVersements,  // contrôleur historique, branché sur le registre commun
  onBasculeRequise = null,
}) {
  const listeners = [];
  let state = null;

  /* ---------- Dérivées : le montant d'une cagnotte vient du journal ---------- */

  function brancherDerivees(c) {
    const def = (nom, get) =>
      Object.defineProperty(c, nom, { get, enumerable: false, configurable: true });
    def('montantActuel', () => versements.engageDe(c.id));
    def('mouvements', () => versements.evenementsDe(c.id));
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

  function normalize(s) {
    return {
      version: VERSION_EUROS,
      ordreManuel: !!(s && s.ordreManuel),
      cagnottes: (Array.isArray(s && s.cagnottes) ? s.cagnottes : []).map(normaliserCagnotte),
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

  /* ---------- Argent : la Bourse, en centimes ---------- */

  /* Euros disponibles dans la Bourse (centimes). Synchrone : tout est local. */
  function soldeDisponible() { return bourse.soldeCentimes(); }

  /* Conservé pour compatibilité : plus rien à attendre, la Bourse est locale. */
  async function rafraichirSolde() { return soldeDisponible(); }

  function totalEngage() {
    return state.cagnottes
      .filter(c => c.statut !== 'archivée')
      .reduce((s, c) => s + versements.engageDe(c.id), 0);
  }

  function totalRecompense() {
    return state.cagnottes
      .filter(c => c.statut === 'archivée')
      .reduce((s, c) => s + versements.engageDe(c.id), 0);
  }

  /* ---------- Historique journalier (dérivé du journal) ---------- */

  function historiqueDe(cagnotteId) {
    const parJour = new Map();
    versements.evenementsDe(cagnotteId).forEach(e => {
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

  /* Alimente une cagnotte depuis la Bourse. Plafonné au solde disponible. */
  async function alimenter(cagnotteId, montantDemande, note = '') {
    const c = getCagnotte(cagnotteId);
    if (!c) return { ok: false, reason: 'introuvable' };
    if (!Number.isFinite(montantDemande) || montantDemande <= 0) return { ok: false, reason: 'montant_invalide' };
    if (c.statut === 'archivée') return { ok: false, reason: 'archivee' };

    const res = await versements.verser(cagnotteId, U.ent(montantDemande), note);
    if (!res.ok) { notify(); return res; }
    majStatutApresMouvement(c);
    notify();
    return { ok: true, effectif: res.amount, ajuste: !!res.adjusted, versementId: res.versementId };
  }

  /*
   * Retire de la cagnotte en annulant son dernier versement encore engagé.
   * Le journal rembourse par référence, en tout-ou-rien.
   */
  async function retirer(cagnotteId, note = '') {
    const c = getCagnotte(cagnotteId);
    if (!c) return { ok: false, reason: 'introuvable' };
    if (c.statut === 'archivée') return { ok: false, reason: 'archivee' };
    const dernier = versements.dernierAnnulable(cagnotteId);
    if (!dernier) return { ok: false, reason: 'cagnotte_vide' };
    return annulerVersement(dernier.id, note ? `Retrait : ${note}` : 'Retrait de la cagnotte');
  }

  async function annulerVersement(versementId, motif = 'Annulation du versement') {
    const rec = versements.versement(versementId);
    if (!rec) return { ok: false, reason: 'introuvable' };
    const c = getCagnotte(rec.cagnotteId);
    const res = await versements.annuler(versementId, motif);
    if (!res.ok) { notify(); return res; }
    if (c) majStatutApresMouvement(c);
    notify();
    return { ok: true, effectif: res.amount };
  }

  function prochainRetrait(cagnotteId) {
    const v = versements.dernierAnnulable(cagnotteId);
    return v ? v.amount : null;
  }

  /* ---------- Conversion Éclats → euros ---------- */

  /* Convertit des Éclats du registre commun en euros dans la Bourse. */
  async function convertirEclats(montantEclats) {
    const res = await bourse.convertir(montantEclats);
    notify();
    return res;
  }

  async function reprendreConversion(conversionId) {
    const res = await bourse.reprendre(conversionId);
    notify();
    return res;
  }

  /* Rend des euros de la Bourse sous forme d'Éclats (montant libre). */
  async function rendreEnEclats(centimes) {
    const res = await bourse.rendre(centimes);
    notify();
    return res;
  }

  async function reprendreReprise(repriseId) {
    const res = await bourse.reprendreReprise(repriseId);
    notify();
    return res;
  }

  /*
   * Une reprise interrompue laisse des euros retirés de la Bourse sans que les
   * Éclats soient encore revenus. On la rejoue au démarrage : elle ne peut que
   * se réparer vers le haut.
   */
  async function acheverReprises() {
    const restantes = bourse.reprisesInachevees();
    if (!restantes.length) return { acheves: 0 };
    let acheves = 0;
    for (const r of restantes) {
      const res = await bourse.reprendreReprise(r.id);
      if (res.ok) acheves += 1;
    }
    notify();
    return { acheves, restantes: bourse.reprisesInachevees().length };
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

  /* Suppression : les euros encore engagés retournent à la Bourse. */
  async function deleteCagnotte(id) {
    const c = getCagnotte(id);
    if (!c) return { ok: false, reason: 'introuvable' };

    let rendus = 0;
    if (c.statut !== 'archivée') {
      for (const v of versements.annulablesDe(id)) {
        const res = await versements.annuler(v.id, `Suppression de la cagnotte « ${c.nom} »`);
        if (!res.ok) {
          notify();
          return { ok: false, reason: 'remboursement_incomplet', rendus, message: res.message };
        }
        rendus += res.amount;
      }
    }

    state.cagnottes = state.cagnottes.filter(x => x.id !== id);
    notify();
    return { ok: true, rendus };
  }

  /*
   * Validation d'une cagnotte à 100 % : archivage. Aucune écriture comptable —
   * les euros ont déjà quitté la Bourse au moment des versements.
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
    return actives.sort((a, b) => (b.montantActuel / b.objectif) - (a.montantActuel / a.objectif));
  }

  function cagnottesArchivees() {
    return state.cagnottes
      .filter(c => c.statut === 'archivée')
      .sort((a, b) => new Date(b.dateArchivage) - new Date(a.dateArchivage));
  }

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
    return JSON.stringify({
      app: 'cagnottes',
      exportDate: new Date().toISOString(),
      version: VERSION_EUROS,
      unite: 'centimes',
      state,
      versements: versements._etat().versements,
      conversions: bourse._etat(),
      bourse: bourse._journalEtat(),
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
    if (Number(s.version) !== VERSION_EUROS) {
      return { ok: false, reason: 'version_incompatible' };
    }

    /*
     * Tout est restauré ensemble : les cagnottes, les versements qui portent
     * leurs montants, et les deux journaux de la Bourse. N'en restaurer qu'une
     * partie produirait des soldes qui ne se répondent plus.
     */
    state = normalize(s);
    versements.remplacerVersements(parsed.versements || {});
    bourse._remplacer({ conversions: parsed.conversions, journal: parsed.bourse });
    notify();
    return { ok: true };
  }

  function resetAll() {
    state = normalize(etatInitialEuros());
    versements.remplacerVersements({});
    notify();
  }

  /* ---------- Séries & estimations ---------- */

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

    let moyenneJour = null;
    const tousMouvements = all.flatMap(c => c.mouvements);
    if (tousMouvements.length) {
      const premier = tousMouvements.reduce((m, x) => x.date < m ? x.date : m, tousMouvements[0].date);
      const nbJours = Math.max(1, U.daysBetween(U.todayKey(new Date(premier)), U.todayKey()) + 1);
      const totalApports = tousMouvements.filter(m => m.montant > 0).reduce((s, m) => s + m.montant, 0);
      moyenneJour = U.ent(totalApports / nbJours);
    }

    let tempsMoyenJours = null, plusRapide = null;
    if (archivees.length) {
      const durees = archivees.map(c => ({
        c,
        jours: Math.max(0, Math.round((new Date(c.dateArchivage) - new Date(c.dateCreation)) / 86400000))
      }));
      tempsMoyenJours = Math.round(durees.reduce((s, d) => s + d.jours, 0) / durees.length);
      plusRapide = durees.sort((a, b) => a.jours - b.jours)[0];
    }

    let meilleurJour = null;
    const apports = tousMouvements.filter(m => m.montant > 0);
    if (apports.length >= 7) {
      const parJour = [0, 0, 0, 0, 0, 0, 0];
      apports.forEach(m => { parJour[new Date(m.date).getDay()] += m.montant; });
      const idx = parJour.indexOf(Math.max(...parJour));
      meilleurJour = { jour: U.jourSemaine(idx), montant: U.ent(parJour[idx]) };
    }

    const deltasFusionnes = new Map();
    all.forEach(c => c.historiqueJournalier.forEach(p => {
      deltasFusionnes.set(p.date, U.ent((deltasFusionnes.get(p.date) || 0) + p.delta));
    }));
    const histoGlobal = [...deltasFusionnes.entries()].map(([date, delta]) => ({ date, delta }));

    const conv = bourse.totaux();

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
      histoGlobal,
      nbConversions: conv.nb,
      eclatsConvertis: conv.eclats,
      eurosObtenus: conv.centimes,
    };
  }

  /* ---------- Bascule Éclats → euros ---------- */

  /*
   * Rembourse tous les versements de test faits en Éclats, puis réétiquette
   * l'état en euros. Rien n'est effacé tant que tous les remboursements ne sont
   * pas confirmés : mieux vaut une bascule reportée que des Éclats perdus.
   */
  async function basculerVersEuros() {
    const ancien = lireBrut();
    if (!estFormatEclats(ancien)) return { ok: false, reason: 'pas_de_bascule' };

    const plan = planRemboursement(ancienVersements ? ancienVersements._etat().versements : {});
    let rembourses = 0;
    for (const v of plan.versements) {
      const res = await ancienVersements.annuler(v.id, 'Retour aux euros : remboursement des tests');
      if (!res.ok) {
        return {
          ok: false, reason: 'remboursement_incomplet',
          rembourses, restants: plan.nb - rembourses, message: res.message,
        };
      }
      rembourses += res.amount;
    }

    // Copie de sécurité de l'état « tout en Éclats » avant réécriture.
    try { localStorage.setItem(CLE_SAUVEGARDE_ECLATS, JSON.stringify(ancien)); }
    catch (e) { console.warn('Copie de sauvegarde Éclats impossible :', e); }

    const conv = convertirEtatEnEuros(ancien);
    state = normalize(conv.etat);
    versements.remplacerVersements({});   // la Bourse démarre à 0 €
    notify();
    return {
      ok: true,
      eclatsRembourses: rembourses,
      nbVersements: plan.nb,
      ...conv.rapport,
    };
  }

  /* ---------- Chargement initial ---------- */

  function lireBrut() {
    try { return JSON.parse(localStorage.getItem(CLE_ETAT) || 'null'); }
    catch { return null; }
  }

  function charger() {
    let brut;
    try { brut = lireBrut(); }
    catch (e) {
      console.error('État localStorage corrompu, réinitialisation :', e);
      state = normalize(etatInitialEuros());
      state._corrupted = true;
      return;
    }

    if (!brut) { state = normalize(etatInitialEuros()); save(); return; }

    if (estFormatEclats(brut)) {
      // On n'écrit RIEN : la bascule exige de rembourser les Éclats d'abord,
      // ce qui demande le réseau et l'accord de l'utilisateur.
      state = normalize(brut);
      state._basculeRequise = true;
      if (onBasculeRequise) onBasculeRequise();
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
    convertirEclats, reprendreConversion, rendreEnEclats, reprendreReprise,
    acheverReprises, basculerVersEuros,
    reordonner, resetOrdre,
    balanceSeries, estimation, stats,
    exportJSON, importJSON, resetAll,
    eclats: versements, bourse,
  };
}
