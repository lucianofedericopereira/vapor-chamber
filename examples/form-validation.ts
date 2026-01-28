/**
 * Form Validation Example
 *
 * Demonstrates: validator plugin, error handling
 */

import { createCommandBus, validator, logger } from '../src';

// Types
interface LoginForm {
  email: string;
  password: string;
}

interface RegisterForm extends LoginForm {
  confirmPassword: string;
  username: string;
}

// Create bus
const bus = createCommandBus();

bus.use(logger());

bus.use(validator({
  'form.login': (cmd) => {
    const { email, password } = cmd.target as LoginForm;

    if (!email?.includes('@')) {
      return 'Invalid email address';
    }
    if (!password || password.length < 8) {
      return 'Password must be at least 8 characters';
    }
    return null;
  },

  'form.register': (cmd) => {
    const { email, password, confirmPassword, username } = cmd.target as RegisterForm;

    if (!username || username.length < 3) {
      return 'Username must be at least 3 characters';
    }
    if (!email?.includes('@')) {
      return 'Invalid email address';
    }
    if (!password || password.length < 8) {
      return 'Password must be at least 8 characters';
    }
    if (password !== confirmPassword) {
      return 'Passwords do not match';
    }
    return null;
  }
}));

// Handlers
bus.register('form.login', (cmd) => {
  const { email } = cmd.target as LoginForm;
  // In real app: call API
  return { success: true, user: { email } };
});

bus.register('form.register', (cmd) => {
  const { email, username } = cmd.target as RegisterForm;
  // In real app: call API
  return { success: true, user: { email, username } };
});

// Usage
console.log('--- Valid login ---');
const loginResult = bus.dispatch('form.login', {
  email: 'user@example.com',
  password: 'securepassword123'
});
console.log('Result:', loginResult);

console.log('\n--- Invalid login (bad email) ---');
const badEmailResult = bus.dispatch('form.login', {
  email: 'not-an-email',
  password: 'securepassword123'
});
console.log('Result:', badEmailResult);

console.log('\n--- Invalid login (short password) ---');
const shortPwResult = bus.dispatch('form.login', {
  email: 'user@example.com',
  password: '123'
});
console.log('Result:', shortPwResult);

console.log('\n--- Valid registration ---');
const registerResult = bus.dispatch('form.register', {
  username: 'johndoe',
  email: 'john@example.com',
  password: 'securepassword123',
  confirmPassword: 'securepassword123'
});
console.log('Result:', registerResult);

console.log('\n--- Invalid registration (password mismatch) ---');
const mismatchResult = bus.dispatch('form.register', {
  username: 'johndoe',
  email: 'john@example.com',
  password: 'securepassword123',
  confirmPassword: 'differentpassword'
});
console.log('Result:', mismatchResult);

export { bus };
