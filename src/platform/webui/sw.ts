/**
 * The service worker: `sw.js`, registered by the page only when the operator turns notifications on.
 *
 * It does two things and nothing else — shows a push as a notification, and opens (or focuses) the
 * page on the topic when the notification is tapped. In particular it has NO `fetch` handler and
 * caches nothing. The web UI README's rule against a service worker was about exactly that: a worker
 * that caches the app shell serves last week's page after an upgrade, with no error to say so. This
 * one cannot, because every request still goes to the network as if it did not exist.
 *
 * Plain ES5-ish JavaScript like the page's own script, kept as a string so it ships inside the
 * package with no build step and no file to locate at runtime.
 */
export const SERVICE_WORKER = `'use strict';
// A push, as webpush.ts sends it: {topic, title, body}, encrypted to this browser.
self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = {}; }
  var title = typeof d.title === 'string' && d.title ? d.title : 'talkcode';
  var body = typeof d.body === 'string' ? d.body : '';
  var topic = typeof d.topic === 'string' ? d.topic : '';
  // One notification per topic (the tag): a second update replaces the first instead of stacking.
  e.waitUntil(self.registration.showNotification(title, {
    body: body,
    tag: topic || 'talkcode',
    renotify: true,
    icon: 'icon.png',
    data: { topic: topic }
  }));
});

// Tapped: bring an open page to the topic, or open one there.
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var topic = e.notification.data && e.notification.data.topic;
  var url = self.registration.scope + (topic ? '?t=' + encodeURIComponent(topic) : '');
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (c.url.indexOf(self.registration.scope) === 0 && 'focus' in c) {
        if (topic) c.postMessage({ goto: topic });
        return c.focus();
      }
    }
    return self.clients.openWindow(url);
  }));
});
`;
