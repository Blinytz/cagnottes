// Moteur du taux de change Éclats → euros, adapté du modèle à régimes de
// WikiDeck (`apps/wikideck/js/eclats.js`).
//
// Principe :
//   * parité de référence : 100 ✦ = 1 € lorsque le taux vaut 1.00 ;
//   * le taux est BORNÉ en permanence entre TAUX_MIN et TAUX_MAX (0,6 – 1,4),
//     soit 100 ✦ = 0,60 € à 1,40 € ;
//   * il traverse des régimes tirés au sort — bas, haut ou neutre — d'une durée
//     aléatoire, puis un nouveau régime est tiré ;
//   * à chaque tick (10 s), lissage exponentiel vers la cible du régime + bruit ;
//   * fermeture de l'app : le temps écoulé est rejoué tick par tick au retour
//     (jusqu'à 7 jours), donc le taux a « vécu » pendant l'absence ;
//   * un historique échantillonné alimente la courbe (6 h à 7 jours).
//
// Le module est une FABRIQUE injectable (storage, now, random) afin d'être
// testable hors navigateur, sans attendre le temps réel.

export const BOURSE_TAUX_KEY = 'cagnottes_taux_v1';

// 100 ✦ valent 1 € au taux 1.00. L'Éclat étant indivisible côté Pronos, la
// conversion travaille en centimes pour rester exacte.
export const ECLATS_PAR_EURO = 100;

export const TAUX_DEFAUTS = {
  min: 0.6,
  max: 1.4,
  // Fractions de la plage min→max où se placent les cibles de chaque régime.
  zoneBasseMax: 0.21,
  zoneNeutreMin: 0.36,
  zoneNeutreMax: 0.57,
  zoneHauteMin: 0.71,
  probaBas: 0.4,
  probaHaut: 0.4,
  probaNeutre: 0.2,
  dureeRegimeMin: 1200,      // 20 min
  dureeRegimeMax: 5400,      // 1 h 30
  frequenceTick: 10,         // secondes entre deux ticks
  lissage: 0.035,            // attraction vers la cible du régime
  bruit: 0.004,              // écart-type du tremblement par tick
  echantillonnage: 300,      // un point de courbe toutes les 5 min
  maxHistorique: 2400,       // ≈ 8,3 jours de points (couvre la fenêtre 7 j)
  maxRattrapage: 604800,     // 7 jours de simulation au retour, au plus
};

// Fenêtres proposées pour la courbe, en heures.
export const FENETRES = [
  { heures: 6, libelle: '6 h' },
  { heures: 12, libelle: '12 h' },
  { heures: 24, libelle: '24 h' },
  { heures: 48, libelle: '2 j' },
  { heures: 96, libelle: '4 j' },
  { heures: 168, libelle: '7 j' },
];

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

export function createTaux({
  storage,
  now = () => Date.now(),
  random = Math.random,
  config = {},
} = {}) {
  const cfg = { ...TAUX_DEFAUTS, ...config };
  const store = storage
    || (typeof globalThis !== 'undefined' && globalThis.localStorage) || memoryStorage();

  const portee = () => cfg.max - cfg.min;

  // Loi normale centrée réduite (Box-Muller), pour un bruit réaliste.
  function gauss() {
    let u = 0, v = 0;
    while (u === 0) u = random();
    while (v === 0) v = random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  function nouveauRegime(quand) {
    const total = cfg.probaBas + cfg.probaHaut + cfg.probaNeutre || 1;
    const r = random() * total;
    let type, cible;
    if (r < cfg.probaBas) {
      type = 'bas';
      cible = cfg.min + portee() * (cfg.zoneBasseMax * random());
    } else if (r < cfg.probaBas + cfg.probaHaut) {
      type = 'haut';
      cible = cfg.min + portee() * (cfg.zoneHauteMin + (1 - cfg.zoneHauteMin) * random());
    } else {
      type = 'neutre';
      cible = cfg.min + portee()
        * (cfg.zoneNeutreMin + (cfg.zoneNeutreMax - cfg.zoneNeutreMin) * random());
    }
    const duree = (cfg.dureeRegimeMin
      + random() * (cfg.dureeRegimeMax - cfg.dureeRegimeMin)) * 1000;
    return { type, cible, finTs: quand + duree };
  }

  function charger() {
    try {
      const parsed = JSON.parse(store.getItem(BOURSE_TAUX_KEY) || 'null');
      if (!parsed || typeof parsed.taux !== 'number' || !parsed.regime) return null;
      if (!Array.isArray(parsed.historique)) parsed.historique = [];
      return parsed;
    } catch {
      return null;
    }
  }

  let etat = charger();
  function sauver() { store.setItem(BOURSE_TAUX_KEY, JSON.stringify(etat)); }

  function init() {
    if (!etat) {
      const maintenant = now();
      etat = {
        taux: 1.0,
        regime: nouveauRegime(maintenant),
        lastTick: maintenant,
        historique: [[maintenant, 1.0]],
        dernierEchantillon: maintenant,
      };
      sauver();
    }
    tick();     // rattrapage du temps passé hors ligne
    return etat;
  }

  function unTick(quand) {
    if (quand >= etat.regime.finTs) etat.regime = nouveauRegime(quand);
    etat.taux += (etat.regime.cible - etat.taux) * cfg.lissage + gauss() * cfg.bruit;
    etat.taux = Math.min(cfg.max, Math.max(cfg.min, etat.taux));
    if (quand - etat.dernierEchantillon >= cfg.echantillonnage * 1000) {
      etat.historique.push([quand, Number(etat.taux.toFixed(4))]);
      etat.dernierEchantillon = quand;
      if (etat.historique.length > cfg.maxHistorique) {
        etat.historique.splice(0, etat.historique.length - cfg.maxHistorique);
      }
    }
  }

  // Avance la simulation jusqu'à l'instant présent. Une absence plus longue que
  // maxRattrapage n'est pas simulée intégralement : inutile de rejouer au-delà
  // de la fenêtre d'historique conservée.
  function tick() {
    if (!etat) return null;
    const pas = cfg.frequenceTick * 1000;
    const maintenant = now();
    if (maintenant - etat.lastTick > cfg.maxRattrapage * 1000) {
      etat.lastTick = maintenant - cfg.maxRattrapage * 1000;
      etat.dernierEchantillon = etat.lastTick;
    }
    let avance = false;
    while (maintenant - etat.lastTick >= pas) {
      etat.lastTick += pas;
      unTick(etat.lastTick);
      avance = true;
    }
    if (avance) sauver();
    return etat.taux;
  }

  function actuel() { return etat?.taux ?? 1.0; }

  // Régime perçu par l'utilisateur, déduit de la position du taux dans la
  // plage — et non du régime interne, dont la cible n'est pas encore atteinte.
  function zone() {
    const f = (actuel() - cfg.min) / portee();
    if (f <= cfg.zoneBasseMax) return 'basse';
    if (f >= cfg.zoneHauteMin) return 'haute';
    return 'neutre';
  }

  // ---- Conversion ----

  // Euros obtenus (en CENTIMES, entiers) pour un nombre d'Éclats donné.
  // Arrondi à l'inférieur : jamais plus que ce que le taux autorise.
  function centimesPour(eclats, taux = actuel()) {
    if (!Number.isFinite(eclats) || eclats <= 0) return 0;
    return Math.floor(eclats * taux * 100 / ECLATS_PAR_EURO);
  }

  // Éclats nécessaires pour obtenir un montant en centimes, au taux courant.
  function eclatsPour(centimes, taux = actuel()) {
    if (!Number.isFinite(centimes) || centimes <= 0) return 0;
    return Math.ceil(centimes * ECLATS_PAR_EURO / (taux * 100));
  }

  // ---- Courbe ----

  // Points de l'historique sur une fenêtre (heures), sous-échantillonnés pour
  // rester légers à tracer sur les grandes fenêtres (7 jours ≈ 2000 points).
  function points(heures, maxPoints = 320) {
    if (!etat) return [];
    const depuis = now() - heures * 3600_000;
    const bruts = etat.historique.filter(([t]) => t >= depuis);
    bruts.push([now(), Number(actuel().toFixed(4))]);
    if (bruts.length <= maxPoints) return bruts;
    const pas = Math.ceil(bruts.length / maxPoints);
    const reduits = bruts.filter((_, i) => i % pas === 0);
    if (reduits[reduits.length - 1] !== bruts[bruts.length - 1]) {
      reduits.push(bruts[bruts.length - 1]);
    }
    return reduits;
  }

  // Variation sur la fenêtre : utile pour dire « en hausse / en baisse ».
  function variation(heures) {
    const pts = points(heures);
    if (pts.length < 2) return 0;
    return pts[pts.length - 1][1] - pts[0][1];
  }

  function svg(heures = 24, largeur = 320, hauteur = 120) {
    const pts = points(heures);
    if (pts.length < 2) {
      return `<svg viewBox="0 0 ${largeur} ${hauteur}" class="graphe-taux" role="img"
        aria-label="Historique du taux en cours de constitution">
        <text x="${largeur / 2}" y="${hauteur / 2}" class="txt-graphe" text-anchor="middle"
        >Historique en cours de constitution…</text></svg>`;
    }
    const t0 = pts[0][0], t1 = pts[pts.length - 1][0];
    const x = (t) => 4 + (largeur - 8) * (t - t0) / Math.max(1, t1 - t0);
    const y = (v) => hauteur - 16 - (hauteur - 30) * (v - cfg.min) / portee();
    const ligne = pts.map(([t, v]) => `${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const yHaut = y(cfg.min + portee() * cfg.zoneHauteMin);
    const yBas = y(cfg.min + portee() * cfg.zoneBasseMax);
    const dernier = pts[pts.length - 1];
    return `<svg viewBox="0 0 ${largeur} ${hauteur}" class="graphe-taux"
      preserveAspectRatio="none" role="img"
      aria-label="Évolution du taux de change sur ${heures} heures">
      <line x1="0" x2="${largeur}" y1="${yHaut}" y2="${yHaut}" class="seuil seuil-haut"/>
      <line x1="0" x2="${largeur}" y1="${yBas}" y2="${yBas}" class="seuil seuil-bas"/>
      <text x="4" y="${(yHaut - 3).toFixed(1)}" class="txt-graphe">zone haute</text>
      <text x="4" y="${(yBas + 11).toFixed(1)}" class="txt-graphe">zone basse</text>
      <polyline points="${ligne}" class="courbe-taux"/>
      <circle cx="${x(dernier[0]).toFixed(1)}" cy="${y(dernier[1]).toFixed(1)}" r="3.5"
        class="point-taux"/>
    </svg>`;
  }

  return {
    init, tick, actuel, zone, centimesPour, eclatsPour,
    points, variation, svg,
    bornes: () => ({ min: cfg.min, max: cfg.max }),
    _etat: () => etat,
  };
}
