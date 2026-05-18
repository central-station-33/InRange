'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createBrowserClient } from '@supabase/ssr';

const nav = [
  { href: '/',          label: 'Pipeline',  icon: '◎' },
  { href: '/analytics', label: 'Analytics', icon: '▤' },
];

export function Sidebar() {
  const path   = usePathname();
  const router = useRouter();

  async function signOut() {
    const supabase = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );
    await supabase.auth.signOut();
    router.push('/login');
  }

  return (
    <aside className="w-56 bg-gray-900 flex flex-col h-full flex-shrink-0">
      <div className="px-6 py-5 border-b border-gray-700">
        <div className="text-white font-bold text-lg leading-tight tracking-tight">InRange</div>
        <div className="text-gray-400 text-xs mt-0.5">ISA Dashboard</div>
      </div>
      <nav className="flex-1 px-3 py-4 space-y-1">
        {nav.map(item => {
          const active = path === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                active
                  ? 'bg-indigo-600 text-white'
                  : 'text-gray-400 hover:text-white hover:bg-gray-800'
              }`}
            >
              <span className="text-base">{item.icon}</span>
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="px-6 py-4 border-t border-gray-700 space-y-3">
        <div className="text-xs text-gray-500 leading-relaxed">
          Highline NY<br />Jet Realty Advisors NJ
        </div>
        <button
          onClick={signOut}
          className="text-xs text-gray-500 hover:text-gray-300 transition-colors w-full text-left"
        >
          Sign out →
        </button>
      </div>
    </aside>
  );
}
