/* global __ENV */
// Load test (k6): read-heavy dashboard traffic + order-list paging against a staging environment.
//   k6 run -e BASE_URL=https://api.staging.example.com -e TOKEN=<access token of a seeded vendor admin> tests/load/k6-api.js
// Thresholds are the SLOs in infrastructure/observability/alerts.yml (p95 < 1 s, error rate < 2 %).
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  scenarios: {
    dashboards: { executor: 'ramping-vus', startVUs: 5, stages: [{ duration: '2m', target: 50 }, { duration: '5m', target: 50 }, { duration: '1m', target: 0 }], exec: 'dashboards' },
    paging: { executor: 'constant-arrival-rate', rate: 30, timeUnit: '1s', duration: '8m', preAllocatedVUs: 40, exec: 'paging' },
  },
  thresholds: { http_req_duration: ['p(95)<1000'], http_req_failed: ['rate<0.02'] },
};
const H = { headers: { authorization: `Bearer ${__ENV.TOKEN}` } };
const get = (p) => http.get(`${__ENV.BASE_URL}${p}`, H);

export function dashboards() {
  for (const p of ['/api/v1/analytics/overview', '/api/v1/analytics/products', '/api/v1/analytics/marketplaces', '/api/v1/orders/summary', '/api/v1/analytics/business-health']) {
    check(get(p), { 'status 200': (r) => r.status === 200 });
  }
  sleep(1);
}

export function paging() {
  const first = get('/api/v1/orders?limit=50');
  check(first, { 'status 200': (r) => r.status === 200 });
  const next = first.json('meta.nextCursor');
  if (next) check(get(`/api/v1/orders?limit=50&cursor=${encodeURIComponent(next)}`), { 'page 2 ok': (r) => r.status === 200 });
}
