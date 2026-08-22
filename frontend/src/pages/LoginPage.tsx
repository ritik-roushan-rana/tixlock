import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { ArrowRight } from 'lucide-react';

import { authApi } from '@/lib/api/endpoints';
import { ApiError } from '@/lib/api/client';
import { useAuthStore, landingPathForRole } from '@/store/auth';
import { queryClient } from '@/lib/queryClient';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { AuthLayout } from '@/components/auth/AuthLayout';
import { DemoAccounts } from '@/components/auth/DemoAccounts';

/**
 * Sign in.
 *
 * Validation is intentionally light: the only client-side rules are "looks like an
 * email" and "not empty". Enforcing a password length here would reject a valid
 * existing password, and the server's 401 is the authority on credentials anyway.
 */
const schema = z.object({
  email: z.string().min(1, 'Email is required').email('Enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
});

type FormValues = z.infer<typeof schema>;

export default function LoginPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const signIn = useAuthStore((s) => s.signIn);

  const next = params.get('next');
  const expired = params.get('expired') === '1';

  useEffect(() => {
    if (expired) toast.info('Your session ended. Please sign in again.');
  }, [expired]);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: '', password: '' },
  });

  const mutation = useMutation({
    mutationFn: authApi.login,
    onSuccess: ({ user, token }) => {
      signIn(user, token);
      // Any cache from a previous session belongs to a different user.
      queryClient.clear();
      toast.success(`Welcome back, ${user.name.split(' ')[0]}`);
      navigate(safeNext(next) ?? landingPathForRole(user.role), { replace: true });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 401) {
        // Surface it on the form rather than as a toast — it is a field problem.
        form.setError('password', { message: 'Incorrect email or password' });
        return;
      }
      toast.error(error instanceof Error ? error.message : 'Could not sign in');
    },
  });

  return (
    <AuthLayout
      statement="Seats, locked."
      blurb="Mechanical precision in high-stakes reservation environments. The tool that stays out of the way until a decision is required."
      nextParam={next}
    >
      {/*
        No card around the form. The reference puts the fields directly on the page
        surface, which is what the "reductionist" rule asks for — a container that
        only draws a boundary and adds nothing is removed in favour of whitespace.
      */}
      <Form {...form}>
        <form
          onSubmit={form.handleSubmit((values) => mutation.mutate(values))}
          className="space-y-6"
          noValidate
        >
          <FormField
            control={form.control}
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Email address</FormLabel>
                <FormControl>
                  <Input
                    type="email"
                    autoComplete="email"
                    placeholder="name@domain.com"
                    autoFocus
                    className="h-12"
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="password"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Password</FormLabel>
                <FormControl>
                  <Input
                    type="password"
                    autoComplete="current-password"
                    className="h-12"
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {/*
            Cobalt, not lime. The reference's auth CTA is cobalt, and it is the right
            call: signing in is the informational gateway to the app, not the
            high-stakes commitment lime is reserved for. Keeping lime unspent here is
            what makes it mean something on "Hold seats" and "Confirm booking".
          */}
          <Button
            type="submit"
            variant="cobalt"
            size="xl"
            className="w-full"
            loading={mutation.isPending}
          >
            Sign in <ArrowRight />
          </Button>
        </form>
      </Form>

      <DemoAccounts
        onPick={(email, password) => {
          form.setValue('email', email);
          form.setValue('password', password);
          form.clearErrors();
        }}
      />
    </AuthLayout>
  );
}

/**
 * Only honour a same-origin absolute path.
 *
 * Accepting an arbitrary `next` would turn the login page into an open redirect
 * that a phishing link could aim at an external site. `//evil.com` is rejected
 * because browsers treat a protocol-relative URL as absolute.
 */
export function safeNext(next: string | null): string | null {
  if (!next) return null;
  if (!next.startsWith('/') || next.startsWith('//')) return null;
  return next;
}
