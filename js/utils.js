'use strict';

/* Utilitaires généraux : formatage, dates, échappement HTML */
const U = {

  /*
   * L'Éclat est indivisible : tout montant est un entier, jamais de décimales.
   * (Même règle que Pronos, qui arrondit côté base de données.)
   */
  ent(v) { return Math.round(Number(v) || 0); },

  /* Formatage d'un montant en Éclats : « 1 250 ✦ » */
  fmtEclats(v) {
    return `${new Intl.NumberFormat('fr-FR').format(U.ent(v))} ✦`;
  },

  /*
   * Les euros sont comptés en CENTIMES entiers : aucune dérive de flottant.
   * Formatage d'un montant en centimes : « 1 250,00 € »
   */
  fmtEuros(centimes) {
    return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' })
      .format(U.ent(centimes) / 100);
  },

  /* Variante compacte sans décimales inutiles : « 12,50 € » / « 600 € » */
  fmtEurosCourt(centimes) {
    const c = U.ent(centimes);
    return c % 100 === 0
      ? new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR',
        maximumFractionDigits: 0 }).format(c / 100)
      : U.fmtEuros(c);
  },

  /*
   * Parse un montant saisi en euros → CENTIMES. Accepte « 12,50 », « 12.50 »,
   * « 1 250 ». NaN si la saisie n'est pas un nombre.
   */
  parseEuros(str) {
    if (typeof str !== 'string' || str.trim() === '') return NaN;
    const v = parseFloat(str.replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(v) ? Math.round(v * 100) : NaN;
  },

  /* Clé de jour locale au format YYYY-MM-DD */
  todayKey(d = new Date()) {
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  },

  keyToDate(k) {
    const [y, m, d] = k.split('-').map(Number);
    return new Date(y, m - 1, d);
  },

  addDays(date, n) {
    const x = new Date(date);
    x.setDate(x.getDate() + n);
    return x;
  },

  daysBetween(k1, k2) {
    return Math.round((U.keyToDate(k2) - U.keyToDate(k1)) / 86400000);
  },

  fmtDate(iso) {
    return new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
  },

  fmtDateTime(iso) {
    return new Date(iso).toLocaleString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  },

  fmtDateKey(k) {
    return U.keyToDate(k).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  },

  esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },

  /*
   * Identifiant de mouvement : DOIT être un UUID valide, car il est envoyé au
   * registre commun dans un paramètre typé `uuid` (p_reference_id). L'ancien
   * repli « base 36 » n'en était pas un et aurait fait échouer les RPC sur les
   * navigateurs sans crypto.randomUUID (contexte non sécurisé, http://).
   */
  uid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    const o = new Uint8Array(16);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(o);
    else for (let i = 0; i < 16; i++) o[i] = Math.floor(Math.random() * 256);
    o[6] = (o[6] & 0x0f) | 0x40;  // version 4
    o[8] = (o[8] & 0x3f) | 0x80;  // variante RFC 4122
    const h = [...o].map(b => b.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  },

  /*
   * Parse un montant saisi en Éclats. Accepte « 1 250 » ou « 1250 » ; une
   * saisie décimale est arrondie à l'entier le plus proche (l'Éclat ne se
   * divise pas). NaN si la saisie n'est pas un nombre.
   */
  parseEclats(str) {
    if (typeof str !== 'string' || str.trim() === '') return NaN;
    const v = parseFloat(str.replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(v) ? U.ent(v) : NaN;
  },

  plural(n, sing, plur) {
    return Math.abs(n) > 1 ? (plur || sing + 's') : sing;
  },

  jourSemaine(idx) {
    return ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'][idx];
  },

  /* Durée lisible en jours entre deux ISO */
  fmtDuree(isoA, isoB) {
    const j = Math.max(0, Math.round((new Date(isoB) - new Date(isoA)) / 86400000));
    if (j === 0) return "moins d'un jour";
    return `${j} ${U.plural(j, 'jour')}`;
  }
};
