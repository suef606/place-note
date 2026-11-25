// place-note 서비스 워커: 홈 화면 앱으로 설치되게 하는 최소 설정 (캐시는 하지 않아요)
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
