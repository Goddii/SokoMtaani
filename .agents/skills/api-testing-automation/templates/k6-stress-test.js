// k6 Stress / Soak Test Template
// Run: k6 run stress-test.js --env BASE_URL=https://api.example.com --env AUTH_TOKEN=your_token

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Rate, Trend, Counter, Gauge } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const AUTH_TOKEN = __ENV.AUTH_TOKEN || '';
const TARGET_RPS = Number(__ENV.TARGET_RPS) || 100;  // Target requests per second

// Metrics
const errorRate = new Rate('errors');
const responseTime = new Trend('response_time');
const activeVUs = new Gauge('active_vus');
const requestCount = new Counter('requests_total');

// Stress test: find breaking point
export const stressOptions = {
  // Ramp up gradually to find breaking point
  stages: [
    { duration: '2m', target: 10 },
    { duration: '3m', target: 25 },
    { duration: '3m', target: 50 },
    { duration: '3m', target: 100 },
    { duration: '3m', target: 200 },
    { duration: '3m', target: 400 },
    { duration: '3m', target: 600 },
    { duration: '5m', target: 0 },
  ],
  thresholds: {
    // Stress test thresholds - more lenient
    http_req_duration: ['p(95)<1000', 'p(99)<2000'],
    http_req_failed: ['rate<0.05'],  // Allow up to 5% errors under stress
  },
};

// Soak test: sustained load for extended period
export const soakOptions = {
  stages: [
    { duration: '10m', target: 50 },  // Ramp up
    { duration: '2h', target: 50 },   // Sustained for 2 hours
    { duration: '10m', target: 0 },   // Ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<300', 'p(99)<800'],
    http_req_failed: ['rate<0.001'],  // Very low error rate for soak
    // Memory leak detection - response time shouldn't grow over time
    // This requires custom analysis of the trend data
  },
};

// Spike test: sudden traffic bursts
export const spikeOptions = {
  stages: [
    { duration: '1m', target: 10 },   // Baseline
    { duration: '30s', target: 200 }, // Sudden spike
    { duration: '1m', target: 10 },   // Back to baseline
    { duration: '30s', target: 300 }, // Bigger spike
    { duration: '1m', target: 10 },   // Baseline
    { duration: '30s', target: 500 }, // Massive spike
    { duration: '5m', target: 0 },    // Recovery
  ],
  thresholds: {
    http_req_duration: ['p(95)<500', 'p(99)<1500'],
    http_req_failed: ['rate<0.1'],    // Allow errors during spikes
  },
};

// Select which test to run via environment variable
const TEST_TYPE = __ENV.TEST_TYPE || 'stress';  // stress, soak, spike
export const options = {
  stress: stressOptions,
  soak: soakOptions,
  spike: spikeOptions,
}[TEST_TYPE];

function headers(extra = {}) {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Authorization': `Bearer ${AUTH_TOKEN}`,
    ...extra,
  };
}

function checkResponse(response, checks) {
  const success = check(response, checks);
  errorRate.add(!success);
  responseTime.add(response.timings.duration);
  requestCount.add(1);
  return success;
}

export default function () {
  activeVUs.add(1);
  
  group('Core API Flow', function () {
    // Health check
    const healthRes = http.get(`${BASE_URL}/health`, { headers: { 'Accept': 'application/json' } });
    checkResponse(healthRes, {
      'health ok': (r) => r.status === 200,
    });
    
    // Authenticated requests
    const authHeaders = headers();
    
    // List users
    const listRes = http.get(`${BASE_URL}/api/users?limit=50`, { headers: authHeaders });
    checkResponse(listRes, {
      'list ok': (r) => r.status === 200,
    });
    
    // Get user
    const userId = '00000000-0000-0000-0000-000000000001';
    const getRes = http.get(`${BASE_URL}/api/users/${userId}`, { headers: authHeaders });
    checkResponse(getRes, {
      'get ok': (r) => r.status === 200 || r.status === 404,
    });
    
    // Search
    const searchRes = http.get(`${BASE_URL}/api/users?search=test`, { headers: authHeaders });
    checkResponse(searchRes, {
      'search ok': (r) => r.status === 200,
    });
  });
  
  activeVUs.add(-1);
  sleep(0.5);  // Short think time for high load
}

export function handleSummary(data) {
  const metrics = data.metrics;
  
  // Calculate key stats
  const totalRequests = metrics.http_reqs?.values?.count || 0;
  const failedRequests = metrics.http_req_failed?.values?.passes || 0;
  const errorRatePct = totalRequests > 0 ? (failedRequests / totalRequests * 100).toFixed(2) : 0;
  const p95 = metrics.http_req_duration?.values?.['p(95)'] || 0;
  const p99 = metrics.http_req_duration?.values?.['p(99)'] || 0;
  const avg = metrics.http_req_duration?.values?.avg || 0;
  const max = metrics.http_req_duration?.values?.max || 0;
  
  return {
    'stdout': `
╔══════════════════════════════════════════════════════════════╗
║                    ${TEST_TYPE.toUpperCase()} TEST SUMMARY                    ║
╠══════════════════════════════════════════════════════════════╣
║  Total Requests:    ${String(totalRequests).padStart(15)} ║
║  Error Rate:        ${String(errorRatePct + '%').padStart(15)} ║
║  Avg Response:      ${String(avg.toFixed(2) + 'ms').padStart(15)} ║
║  p95 Response:      ${String(p95.toFixed(2) + 'ms').padStart(15)} ║
║  p99 Response:      ${String(p99.toFixed(2) + 'ms').padStart(15)} ║
║  Max Response:      ${String(max.toFixed(2) + 'ms').padStart(15)} ║
╚══════════════════════════════════════════════════════════════╝
    `,
    'summary.json': JSON.stringify(data, null, 2),
  };
}