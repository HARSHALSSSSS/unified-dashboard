// Loaded before every test file: guarantees a hermetic, secret-free test environment.
import { TEST_ENV } from '@oms/testing';

for (const [k, v] of Object.entries(TEST_ENV)) process.env[k] ??= v;
