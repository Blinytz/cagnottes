'use strict';

/* Utilitaires généraux : formatage, dates, échappement HTML */
const U = {

  /* Arrondi monétaire à 2 décimales (évite les dérives de flottants) */
  r2(v) { return Math.round((v + Number.EPSILON) * 100) / 100; },

  fmtEUR(v) {
    return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(v);
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

  uid() {
    return (crypto.randomUUID)
      ? crypto.randomUUID()
      : Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  },

  /* Parse un montant saisi ("12,50" ou "12.50") → nombre arrondi, NaN si invalide */
  parseMontant(str) {
    if (typeof str !== 'string' || str.trim() === '') return NaN;
    const v = parseFloat(str.replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(v) ? U.r2(v) : NaN;
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
