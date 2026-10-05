// k6 Load Test Template
// Run: k6 run load-test.js --env BASE_URL=https://api.example.com --env AUTH_TOKEN=your_token

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';

// Custom metrics
const errorRate = new Rate('errors');
const responseTime = new Trend('response_time');
const requestCount = new Counter('requests_total');

// Test configuration via environment variables
const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const AUTH_TOKEN = __ENV.AUTH_TOKEN || '';
const TEST_DURATION = __ENV.TEST_DURATION || '10m';

// Load profile stages (adjust for your needs)
export const options = {
  stages: [
    { duration: '1m', target: 5 },    // Warm up
    { duration: '3m', target: 20 },   // Normal load
    { duration: '2m', target: 50 },   // Peak load
    { duration: '3m', target: 50 },   // Sustained peak
    { duration: '1m', target: 0 },    // Cool down
  ],
  thresholds: {
    // Global thresholds
    http_req_duration: ['p(95)<200', 'p(99)<500'],
    http_req_failed: ['rate<0.01'],
    
    // Custom metric thresholds
    'response_time': ['p(95)<200'],
    'errors': ['rate<0.01'],
  },
  
  // Optional: discard response bodies to save memory
  discardResponseBodies: true,
  
  // Optional: enable summary output
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
};

// Helper: build headers with auth
function headers(extra = {}) {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Authorization': `Bearer ${AUTH_TOKEN}`,
    ...extra,
  };
}

// Helper: check response and record metrics
function checkResponse(response, checks, metricName) {
  const success = check(response, checks);
  errorRate.add(!success);
  responseTime.add(response.timings.duration);
  requestCount.add(1);
  return success;
}

export default function () {
  // ===== AUTHENTICATION =====
  group('Authentication', function () {
    const loginRes = http.post(`${BASE_URL}/auth/login`, JSON.stringify({
      email: 'loadtest@example.com',
      password: 'loadtestpass123',
    }), { headers: headers({ 'Authorization': '' }) });
    
    checkResponse(loginRes, {
      'login status 200': (r) => r.status === 200,
      'login has token': (r) => r.json('token') !== undefined,
      'login < 300ms': (r) => r.timings.duration < 300,
    }, 'login');
  });
  
  // Extract token for subsequent requests (in real test, you'd cache this)
  // For simplicity, we use the pre-provided AUTH_TOKEN
  
  // ===== USER MANAGEMENT =====
  group('User Management', function () {
    // List users
    const listRes = http.get(`${BASE_URL}/api/users`, { headers: headers() });
    checkResponse(listRes, {
      'list status 200': (r) => r.status === 200,
      'list returns array': (r) => Array.isArray(r.json()),
      'list < 200ms': (r) => r.timings.duration < 200,
    }, 'list_users');
    
    // Get single user (use a known ID or create one)
    const userId = '00000000-0000-0000-0000-000000000001';
    const getRes = http.get(`${BASE_URL}/api/users/${userId}`, { headers: headers() });
    checkResponse(getRes, {
      'get status 200': (r) => r.status === 200,
      'get has email': (r) => r.json('email') !== undefined,
      'get < 150ms': (r) => r.timings.duration < 150,
    }, 'get_user');
    
    // Create user (if your API allows)
    // const createRes = http.post(`${BASE_URL}/api/users`, JSON.stringify({
    //   name: `LoadTest User ${__VU}-${__ITER}`,
    //   email: `loadtest-${__VU}-${__ITER}@example.com`,
    //   role: 'user',
    // }), { headers: headers() });
    // checkResponse(createRes, { ... }, 'create_user');
  });
  
  // ===== SEARCH / QUERY =====
  group('Search & Query', function () {
    const searchRes = http.get(`${BASE_URL}/api/users?search=test&limit=20`, { headers: headers() });
    checkResponse(searchRes, {
      'search status 200': (r) => r.status === 200,
      'search returns results': (r) => r.json().length >= 0,
      'search < 250ms': (r) => r.timings.duration < 250,
    }, 'search_users');
  });
  
  // ===== HEALTH / READINESS =====
  group('Health Checks', function () {
    const healthRes = http.get(`${BASE_URL}/health`, { headers: { 'Accept': 'application/json' } });
    checkResponse(healthRes, {
      'health status 200': (r) => r.status === 200,
      'health < 50ms': (r) => r.timings.duration < 50,
    }, 'health');
  });
  
  // Realistic think time
  sleep(1);
}

// Optional: Handle summary for custom reporting
export function handleSummary(data) {
  return {
    'stdout': textSummary(data, { indent: ' ', enableColors: true }),
    'summary.json': JSON.stringify(data, null, 2),
  };
}

function textSummary(data, options) {
  // Simple text summary - k6 provides this built-in
  return '';
}