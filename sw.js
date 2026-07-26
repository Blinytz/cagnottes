'use strict';

/* Service worker : pré-cache de tous les assets pour un fonctionnement 100 % hors-ligne.
   Incrémenter CACHE_VERSION à chaque mise à jour de l'app pour invalider l'ancien cache. */
const CACHE_VERSION = 'cagnottes-v3-euros';
const ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/utils.js',
  './js/charts.js',
  './js/views.js',
  './js/app.js',
  './js/main.js',
  './js/store.js',
  './js/eclats-local.js',
  './js/eclats-cagnottes.js',
  './js/eclats-registre.js',
  './js/eclats-migration.js',
  './js/bourse.js',
  './js/bourse-taux.js',
  './js/bascule-euros.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_VERSION).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* Stratégie cache-first, avec mise en cache au vol des ressources same-origin
   (utile pour les images de cagnottes chargées par URL sur le même domaine). */
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(resp => {
        const url = new URL(e.request.url);
        if (resp.ok && url.origin === location.origin) {
          const clone = resp.clone();
          caches.open(CACHE_VERSION).then(c => c.put(e.request, clone));
        }
        return resp;
      }).catch(() => {
        /* Hors-ligne et absent du cache : renvoie la coquille de l'app pour les navigations */
        if (e.request.mode === 'navigate') return caches.match('./index.html');
        return new Response('', { status: 503, statusText: 'Hors-ligne' });
      });
    })
  );
});
