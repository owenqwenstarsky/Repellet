import { useState, useRef, useEffect } from 'react';
import type { User } from '@repellet/shared';
import { ArrowRight, TerminalSquare, FolderCode, Users, LockKeyhole } from 'lucide-react';
import { post, errorMessage } from './api';
import { Logo, Field, Button, FormError } from './ui';
export function Auth({ setup, onAuth }: { setup: boolean; onAuth: (user: User) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return (
    <main className="auth-screen">
      <aside className="auth-story">
        <Logo />
        <div className="auth-story-main">
          <div className="eyebrow">SELF-HOSTED DEVELOPMENT</div>
          <h1>
            A workspace
            <br />
            of your own.
          </h1>
          <p>
            Write, run, and build together.
            <br />
            Everything stays on your server.
          </p>
          <div className="auth-features">
            <span>
              <FolderCode size={18} /> Your files and tools
            </span>
            <span>
              <TerminalSquare size={18} /> Real container environments
            </span>
            <span>
              <Users size={18} /> A place for your team
            </span>
          </div>
        </div>
        <span className="auth-foot">
          <span className="online-dot" /> Repellet · v0.1
        </span>
      </aside>
      <section className="auth-form-wrap">
        <form
          className="auth-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (inFlight.current) return;
            inFlight.current = true;
            setBusy(true);
            setError('');
            const b = Object.fromEntries(new FormData(e.currentTarget));
            try {
              const result = await post<{ user: User }>(setup ? '/setup' : '/auth/login', b);
              if (mounted.current) onAuth(result.user);
            } catch (e) {
              if (mounted.current) setError(errorMessage(e));
            } finally {
              inFlight.current = false;
              if (mounted.current) setBusy(false);
            }
          }}
        >
          <div className="auth-icon">
            <LockKeyhole size={24} />
          </div>
          <h2>{setup ? 'Set up your workspace' : 'Welcome back'}</h2>
          <p className="muted">
            {setup
              ? 'Create the owner account to get started.'
              : 'Sign in to your Repellet account.'}
          </p>
          {setup && (
            <>
              <Field
                label="Setup token"
                help={
                  <>
                    Find it with <code>docker compose logs app</code>.
                  </>
                }
              >
                <input
                  name="token"
                  autoFocus
                  required
                  autoComplete="off"
                  placeholder="Token from the server logs"
                />
              </Field>
              <Field label="Display name">
                <input
                  name="displayName"
                  required
                  maxLength={80}
                  autoComplete="name"
                  placeholder="Your name"
                />
              </Field>
            </>
          )}
          <Field label="Username">
            <input
              name="username"
              autoFocus={!setup}
              required
              minLength={3}
              maxLength={40}
              pattern="[a-zA-Z0-9_.\-]+"
              autoComplete="username"
              placeholder="Your username"
            />
          </Field>
          <Field label="Password">
            <input
              type="password"
              name="password"
              required
              minLength={12}
              maxLength={128}
              autoComplete={setup ? 'new-password' : 'current-password'}
              placeholder={setup ? 'At least 12 characters' : 'Your password'}
            />
          </Field>
          {error && <FormError>{error}</FormError>}
          <Button
            type="submit"
            variant="primary"
            className="auth-submit"
            busy={busy}
            icon={<ArrowRight size={16} />}
          >
            {setup ? 'Create owner account' : 'Sign in'}
          </Button>
          <p className="auth-note">
            {setup
              ? 'You can add more people after setup.'
              : 'Accounts are created by your site owner.'}
          </p>
        </form>
      </section>
    </main>
  );
}
