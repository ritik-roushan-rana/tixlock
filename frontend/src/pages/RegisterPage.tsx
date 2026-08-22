import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { ArrowRight, CalendarDays, Ticket } from 'lucide-react';

import { authApi } from '@/lib/api/endpoints';
import { ApiError } from '@/lib/api/client';
import { useAuthStore, landingPathForRole } from '@/store/auth';
import { queryClient } from '@/lib/queryClient';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { AuthLayout } from '@/components/auth/AuthLayout';
import { safeNext } from './LoginPage';

/**
 * Registration.
 *
 * Password rules mirror the server exactly: minimum 8 characters and at most 72
 * *bytes*. The byte cap is not arbitrary — bcrypt silently truncates input past 72
 * bytes, which would make two different long passwords interchangeable, so the
 * backend rejects them outright. Checking it here turns a confusing 400 into an
 * inline message. Note the byte length differs from `.length` for non-ASCII input,
 * hence TextEncoder.
 */
const schema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120, 'Name is too long'),
  email: z.string().min(1, 'Email is required').email('Enter a valid email address'),
  password: z
    .string()
    .min(8, 'Use at least 8 characters')
    .refine(
      (value) => new TextEncoder().encode(value).length <= 72,
      'Password must be at most 72 bytes'
    ),
  role: z.enum(['customer', 'organiser']),
});

type FormValues = z.infer<typeof schema>;

const ROLE_OPTIONS = [
  {
    value: 'customer' as const,
    title: 'Book tickets',
    description: 'Browse events and reserve seats.',
    icon: Ticket,
  },
  {
    value: 'organiser' as const,
    title: 'List events',
    description: 'Create shows and track sales.',
    icon: CalendarDays,
  },
];

export default function RegisterPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const signIn = useAuthStore((s) => s.signIn);
  const next = params.get('next');

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', email: '', password: '', role: 'customer' },
  });

  const selectedRole = form.watch('role');

  const mutation = useMutation({
    mutationFn: authApi.register,
    onSuccess: ({ user, token }) => {
      // The API returns a token with the 201, so there is no second login round trip.
      signIn(user, token);
      queryClient.clear();
      toast.success('Account created');
      navigate(safeNext(next) ?? landingPathForRole(user.role), { replace: true });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        form.setError('email', { message: 'An account with that email already exists' });
        return;
      }
      if (error instanceof ApiError && error.status === 400) {
        toast.error(error.message);
        return;
      }
      toast.error(error instanceof Error ? error.message : 'Could not create your account');
    },
  });

  return (
    <AuthLayout
      statement="Book it. Keep it."
      blurb="Create an account to hold seats, complete bookings and keep every ticket in one place."
      nextParam={next}
    >
      <Form {...form}>
        <form
          onSubmit={form.handleSubmit((values) => mutation.mutate(values))}
          className="space-y-6"
          noValidate
        >
          <FormField
            control={form.control}
            name="role"
            render={({ field }) => (
              <FormItem>
                <FormLabel>I want to</FormLabel>
                {/*
                  The reference's two role cards. Selection is a 2px cobalt border on
                  a page-coloured card against tonal unselected ones — cobalt is this
                  system's selection signal, and the surface step does the rest, so no
                  tinted fill is needed.
                */}
                <div className="grid grid-cols-2 gap-3" role="radiogroup">
                  {ROLE_OPTIONS.map(({ value, title, description, icon: Icon }) => (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={selectedRole === value}
                      onClick={() => field.onChange(value)}
                      className={cn(
                        'flex flex-col gap-1.5 p-4 text-left transition-colors',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        selectedRole === value
                          ? 'border-2 border-cobalt bg-background'
                          : 'border-2 border-transparent bg-card hover:border-border-strong'
                      )}
                    >
                      <Icon
                        className={cn(
                          'h-4 w-4',
                          selectedRole === value ? 'text-cobalt' : 'text-muted-foreground'
                        )}
                        aria-hidden
                      />
                      <span className="text-sm font-semibold">{title}</span>
                      <span className="text-xs text-muted-foreground">{description}</span>
                    </button>
                  ))}
                </div>
                <FormDescription>
                  Admin accounts are provisioned by the platform and cannot be self-registered.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Full name</FormLabel>
                <FormControl>
                  <Input autoComplete="name" placeholder="Asha Rao" className="h-12" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

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
                    autoComplete="new-password"
                    className="h-12"
                    {...field}
                  />
                </FormControl>
                <FormDescription>At least 8 characters.</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Cobalt, matching sign in — see the note on LoginPage's submit. */}
          <Button
            type="submit"
            variant="cobalt"
            size="xl"
            className="w-full"
            loading={mutation.isPending}
          >
            Create account <ArrowRight />
          </Button>
        </form>
      </Form>
    </AuthLayout>
  );
}
