/**
 * Form Validation Example
 *
 * Shows a login and a register form refused with a message before the handler
 * runs. The form is the command's PAYLOAD (its input). A `validator` rule is
 * the first message that fails, and a refusal answers
 * `result.error.code === 'validator:invalid:payload'`.
 */

import { createCommandBus, logger, validator, type Command } from 'vapor-chamber';

interface LoginForm { email: string; password: string }
interface RegisterForm extends LoginForm { confirmPassword: string; username: string }

// One check per field, each a message or null; a form's rule is the first message.
const email = (value?: string) => (value?.includes('@') ? null : 'Invalid email address');
const password = (value?: string) => (value && value.length >= 8 ? null : 'Password must be at least 8 characters');
const username = (value?: string) => (value && value.length >= 3 ? null : 'Username must be at least 3 characters');
const first = (...messages: (string | null)[]) => messages.find((message) => message !== null) ?? null;
// A rule reads the payload as the form it validates.
const onForm = <F>(rule: (form: F) => string | null) => (cmd: Command) => rule(cmd.payload as F);

const bus = createCommandBus();

bus.use(logger());
bus.use(validator({
  formLogin: onForm((f: LoginForm) => first(email(f.email), password(f.password))),
  formRegister: onForm((f: RegisterForm) =>
    first(username(f.username), email(f.email), password(f.password), f.password === f.confirmPassword ? null : 'Passwords do not match')),
}));

bus.register('formLogin', ({ payload }) => ({ success: true, user: { email: payload.email } }));
bus.register('formRegister', ({ payload }) => ({ success: true, user: { email: payload.email, username: payload.username } }));

const attempts: [title: string, action: string, form: LoginForm | RegisterForm][] = [
  ['Valid login', 'formLogin', { email: 'user@example.com', password: 'securepassword123' }],
  ['Invalid login (bad email)', 'formLogin', { email: 'not-an-email', password: 'securepassword123' }],
  ['Invalid login (short password)', 'formLogin', { email: 'user@example.com', password: '123' }],
  ['Valid registration', 'formRegister', { username: 'johndoe', email: 'john@example.com', password: 'securepassword123', confirmPassword: 'securepassword123' }],
  ['Invalid registration (password mismatch)', 'formRegister', { username: 'johndoe', email: 'john@example.com', password: 'securepassword123', confirmPassword: 'differentpassword' }],
];

attempts.forEach(([title, action, form], i) => {
  console.log(`${i ? '\n' : ''}--- ${title} ---`);
  console.log('Result:', bus.dispatch(action, {}, form));
});
