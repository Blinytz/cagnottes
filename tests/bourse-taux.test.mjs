// Tests du moteur de taux : bornes, régimes, rattrapage hors-ligne, historique
// et conversion. Le temps et le hasard sont injectés → résultats reproductibles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTaux, TAUX_DEFAUTS, FENETRES, ECLATS_PAR_EURO, BOURSE_TAUX_KEY,
} from '../js/bourse-taux.js';

function fakeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _map: m,
  };
}

// Horloge contrôlée : on avance le temps à la demande.
function horloge(depart = Date.parse('2026-07-26T12:00:00Z')) {
  let t = depart;
  return { now: () => t, avancer: (secondes) => { t += secondes * 1000; }, valeur: () => t };
}

// Hasard déterministe (générateur congruentiel), pour des tests reproductibles.
function alea(graine = 42) {
  let s = graine;
  return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
}

test('le taux démarre à 1.00 et reste dans les bornes 0,6–1,4', () => {
  const h = horloge();
  const t = createTaux({ storage: fakeStorage(), now: h.now, random: alea() });
  t.init();
  assert.equal(t.actuel(), 1.0);

  // Une semaine de simulation : le taux ne doit jamais sortir des bornes.
  for (let i = 0; i < 7 * 24; i++) {
    h.avancer(3600);
    t.tick();
    const v = t.actuel();
    assert.ok(v >= 0.6 && v <= 1.4, `taux hors bornes : ${v}`);
  }
});

test('le taux bouge réellement au fil du temps', () => {
  const h = horloge();
  const t = createTaux({ storage: fakeStorage(), now: h.now, random: alea(7) });
  t.init();
  h.avancer(6 * 3600);
  t.tick();
  assert.notEqual(t.actuel(), 1.0);
});

test('rattrapage hors-ligne : le taux évolue même app fermée', () => {
  const h = horloge();
  const storage = fakeStorage();
  const t1 = createTaux({ storage, now: h.now, random: alea(3) });
  t1.init();
  const avant = t1.actuel();

  // « App fermée » 12 h, puis réouverture : nouvelle instance, même stockage.
  h.avancer(12 * 3600);
  const t2 = createTaux({ storage, now: h.now, random: alea(3) });
  t2.init();
  assert.notEqual(t2.actuel(), avant);
  assert.ok(t2.actuel() >= 0.6 && t2.actuel() <= 1.4);
});

test('une absence très longue ne simule pas au-delà du rattrapage maximal', () => {
  const h = horloge();
  const storage = fakeStorage();
  createTaux({ storage, now: h.now, random: alea(5) }).init();

  h.avancer(120 * 24 * 3600);           // 120 jours d'absence
  const debut = Date.now();
  const t = createTaux({ storage, now: h.now, random: alea(5) });
  t.init();
  assert.ok(Date.now() - debut < 5000, 'le rattrapage doit rester borné');
  assert.ok(t.actuel() >= 0.6 && t.actuel() <= 1.4);
});

test('l’historique est échantillonné et plafonné', () => {
  const h = horloge();
  const t = createTaux({ storage: fakeStorage(), now: h.now, random: alea(11) });
  t.init();
  for (let i = 0; i < 10 * 24; i++) { h.avancer(3600); t.tick(); }
  const histo = t._etat().historique;
  assert.ok(histo.length <= TAUX_DEFAUTS.maxHistorique);
  // 10 jours à un point / 5 min dépasse le plafond : on doit être au plafond.
  assert.equal(histo.length, TAUX_DEFAUTS.maxHistorique);
});

test('les fenêtres proposées vont de 6 h à 7 jours', () => {
  assert.deepEqual(FENETRES.map((f) => f.heures), [6, 12, 24, 48, 96, 168]);
  assert.equal(FENETRES[FENETRES.length - 1].libelle, '7 j');
});

test('la fenêtre 7 jours renvoie des points et reste légère à tracer', () => {
  const h = horloge();
  const t = createTaux({ storage: fakeStorage(), now: h.now, random: alea(13) });
  t.init();
  for (let i = 0; i < 7 * 24; i++) { h.avancer(3600); t.tick(); }
  const pts = t.points(168);
  assert.ok(pts.length > 10, 'la courbe 7 j doit avoir des points');
  assert.ok(pts.length <= 321, `sous-échantillonnage attendu, reçu ${pts.length}`);
  const svg = t.svg(168);
  assert.match(svg, /<polyline/);
  assert.match(svg, /7 heures|168 heures/);
});

test('conversion : 100 ✦ valent 1 € au taux 1.00', () => {
  const t = createTaux({ storage: fakeStorage(), random: alea() });
  t.init();
  assert.equal(ECLATS_PAR_EURO, 100);
  assert.equal(t.centimesPour(100, 1.0), 100);   // 1,00 €
  assert.equal(t.centimesPour(1000, 1.0), 1000); // 10,00 €
});

test('conversion aux bornes : 100 ✦ donnent 0,60 € à 1,40 €', () => {
  const t = createTaux({ storage: fakeStorage(), random: alea() });
  t.init();
  assert.equal(t.centimesPour(100, 0.6), 60);
  assert.equal(t.centimesPour(100, 1.4), 140);
});

test('la conversion arrondit toujours à l’inférieur (jamais d’euro offert)', () => {
  const t = createTaux({ storage: fakeStorage(), random: alea() });
  t.init();
  // 33 ✦ à 1.00 → 0,33 € ; 33 ✦ à 0,777 → 0,2564… → 25 centimes
  assert.equal(t.centimesPour(33, 1.0), 33);
  assert.equal(t.centimesPour(33, 0.777), 25);
  assert.equal(t.centimesPour(0, 1.0), 0);
  assert.equal(t.centimesPour(-5, 1.0), 0);
});

test('eclatsPour est le miroir de centimesPour (arrondi au supérieur)', () => {
  const t = createTaux({ storage: fakeStorage(), random: alea() });
  t.init();
  assert.equal(t.eclatsPour(100, 1.0), 100);   // 1 € coûte 100 ✦
  assert.equal(t.eclatsPour(100, 1.4), 72);    // 72 ✦ × 1,4 = 100,8 ct ≥ 100
  assert.ok(t.centimesPour(t.eclatsPour(250, 0.9), 0.9) >= 250);
});

test('la zone reflète la position du taux dans la plage', () => {
  const t = createTaux({ storage: fakeStorage(), random: alea() });
  t.init();
  const e = t._etat();
  e.taux = 0.62; assert.equal(t.zone(), 'basse');
  e.taux = 1.00; assert.equal(t.zone(), 'neutre');
  e.taux = 1.35; assert.equal(t.zone(), 'haute');
});

test('l’état du taux est persisté sous sa propre clé', () => {
  const storage = fakeStorage();
  const h = horloge();
  const t = createTaux({ storage, now: h.now, random: alea() });
  t.init();
  h.avancer(3600); t.tick();
  assert.ok(storage.getItem(BOURSE_TAUX_KEY), 'le taux doit être sauvegardé');
  // Il ne touche à aucune donnée métier de Cagnottes.
  assert.equal(storage.getItem('cagnottes_app_state_v1'), null);
});
