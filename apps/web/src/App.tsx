import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BookOpen,
  ChartNoAxesCombined,
  Check,
  ChevronRight,
  Clock3,
  LayoutDashboard,
  Leaf,
  LogOut,
  Plus,
  RefreshCw,
  Settings2,
  ShieldCheck,
  X,
} from 'lucide-react';
import { api, ApiError, post } from './api';
import { mergeRefreshScope, retainEqual, type RefreshScope } from './refresh';
import Auth from './Auth';
import Dashboard from './Dashboard';
import TradeForm from './TradeForm';
import TradeDetail from './TradeDetail';
import Journal from './Journal';
import Insights from './Insights';
import Settings from './Settings';
import { Brand, ErrorBox } from './ui';
import type { Account, Auth as AuthData, EquityCurve, Page, Stats, Trade } from './types';

const navigation: { id: Page; label: string; icon: typeof LayoutDashboard }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'trade', label: 'New trade', icon: Plus },
  { id: 'journal', label: 'Journal', icon: BookOpen },
  { id: 'insights', label: 'Insights', icon: ChartNoAxesCombined },
  { id: 'settings', label: 'Settings', icon: Settings2 },
];
function currentPage(): Page {
  const value = window.location.hash.slice(1);
  return navigation.some((n) => n.id === value) ? (value as Page) : 'overview';
}

export default function App() {
  const [auth, setAuth] = useState<AuthData | null>(null);
  const [checking, setChecking] = useState(true);
  const [authError, setAuthError] = useState('');
  const [page, setPage] = useState<Page>(currentPage);
  const [account, setAccount] = useState<Account | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [curve, setCurve] = useState<EquityCurve | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [toast, setToast] = useState('');
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const refreshingRef = useRef(false);
  const pendingRefresh = useRef<{ silent: boolean; scope: RefreshScope } | null>(null);
  const authEpoch = useRef(0);
  const activeAuth = useRef<AuthData | null>(null);
  const activeRefresh = useRef<AbortController | null>(null);
  const authLookup = useRef(0);
  const logoutInFlight = useRef(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notify = useCallback((message: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = setTimeout(() => setToast(''), 6000);
  }, []);
  function navigate(next: Page) {
    window.location.hash = next;
    setPage(next);
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
  const clearPrivateState = useCallback(() => {
    authEpoch.current += 1;
    activeRefresh.current?.abort();
    activeRefresh.current = null;
    refreshingRef.current = false;
    pendingRefresh.current = null;
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setAccount(null);
    setTrades([]);
    setStats(null);
    setCurve(null);
    setSelected(null);
    setToast('');
    setError('');
    setRefreshing(false);
    setLastUpdated(null);
    setRevision(0);
  }, []);
  const authenticate = useCallback(
    (result: AuthData) => {
      clearPrivateState();
      authLookup.current += 1;
      activeAuth.current = result;
      setAuth(result);
      setAuthError('');
      setChecking(false);
    },
    [clearPrivateState],
  );
  const endSession = useCallback(() => {
    clearPrivateState();
    authLookup.current += 1;
    activeAuth.current = null;
    setAuth(null);
    setChecking(false);
  }, [clearPrivateState]);
  const loadAuth = useCallback(() => {
    const lookup = ++authLookup.current;
    const epoch = authEpoch.current;
    setChecking(true);
    setAuthError('');
    api<AuthData>('/auth/me')
      .then((result) => {
        if (lookup === authLookup.current && epoch === authEpoch.current) authenticate(result);
      })
      .catch((e) => {
        if (lookup !== authLookup.current || epoch !== authEpoch.current) return;
        if (!(e instanceof ApiError && e.status === 401)) setAuthError(e.message);
      })
      .finally(() => {
        if (lookup === authLookup.current) setChecking(false);
      });
  }, [authenticate]);
  useEffect(() => {
    loadAuth();
    const onHash = () => setPage(currentPage());
    window.addEventListener('hashchange', onHash);
    return () => {
      window.removeEventListener('hashchange', onHash);
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, [loadAuth]);
  const refresh = useCallback(
    async function refreshData(silent = false, scope: RefreshScope = 'all'): Promise<void> {
      if (!auth || activeAuth.current?.accountId !== auth.accountId) return;
      if (refreshingRef.current) {
        const pending = pendingRefresh.current;
        pendingRefresh.current = {
          silent: silent && (pending?.silent ?? true),
          scope: pending ? mergeRefreshScope(pending.scope, scope) : scope,
        };
        return;
      }
      const epoch = authEpoch.current;
      const controller = new AbortController();
      activeRefresh.current = controller;
      refreshingRef.current = true;
      if (!silent) setRefreshing(true);
      try {
        const [a, t, s, e] = await Promise.all([
          api<Account>('/account', { signal: controller.signal }),
          scope !== 'account'
            ? api<{ trades: Trade[] }>('/trades', { signal: controller.signal })
            : null,
          scope === 'all' ? api<Stats>('/stats', { signal: controller.signal }) : null,
          scope === 'all'
            ? api<EquityCurve>('/stats/equity-curve', { signal: controller.signal })
            : null,
        ]);
        if (epoch !== authEpoch.current || activeAuth.current?.accountId !== auth.accountId) return;
        setAccount((previous) => retainEqual(previous, a));
        if (t) setTrades((previous) => retainEqual(previous, t.trades));
        if (s) setStats((previous) => retainEqual(previous, s));
        if (e) setCurve((previous) => retainEqual(previous, e));
        setLastUpdated(new Date());
        setError('');
        if (scope === 'all') setRevision((v) => v + 1);
      } catch (e) {
        if (epoch !== authEpoch.current || controller.signal.aborted) return;
        if (e instanceof ApiError && e.status === 401) {
          endSession();
        } else setError((e as Error).message);
      } finally {
        if (activeRefresh.current === controller) {
          activeRefresh.current = null;
          refreshingRef.current = false;
          setRefreshing(false);
          const pending = pendingRefresh.current;
          pendingRefresh.current = null;
          if (pending) void refreshData(pending.silent, pending.scope);
        }
      }
    },
    [auth, endSession],
  );
  useEffect(() => {
    if (!auth) return;
    void refresh();
    const timer = setInterval(() => void refresh(true), 20000);
    const stream = new EventSource('/api/stream', { withCredentials: true });
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let pendingScope: RefreshScope | null = null;
    const invalidate = (event: Event) => {
      const scope =
        event.type === 'price' ? 'market' : event.type === 'feed_status' ? 'account' : 'all';
      pendingScope = pendingScope ? mergeRefreshScope(pendingScope, scope) : scope;
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => {
        const next = pendingScope!;
        pendingScope = null;
        void refresh(true, next);
      }, 500);
    };
    for (const event of ['price', 'trade_filled', 'trade_exited', 'trade_updated', 'feed_status'])
      stream.addEventListener(event, invalidate);
    return () => {
      clearInterval(timer);
      if (timeout) clearTimeout(timeout);
      stream.close();
    };
  }, [auth, refresh]);
  async function logout() {
    if (logoutInFlight.current) return;
    logoutInFlight.current = true;
    // An older account request must never be allowed to repaint after logout or a user switch.
    const epoch = ++authEpoch.current;
    const accountId = activeAuth.current?.accountId;
    activeRefresh.current?.abort();
    activeRefresh.current = null;
    refreshingRef.current = false;
    pendingRefresh.current = null;
    try {
      await post('/auth/logout', {});
      if (epoch === authEpoch.current && accountId === activeAuth.current?.accountId) {
        endSession();
        navigate('overview');
      }
    } catch (e) {
      if (epoch === authEpoch.current && accountId === activeAuth.current?.accountId) {
        notify((e as Error).message);
        void refresh(true);
      }
    } finally {
      logoutInFlight.current = false;
    }
  }
  function changed(message: string) {
    if (activeAuth.current?.accountId !== auth?.accountId) return;
    notify(message);
    void refresh(true);
  }
  if (checking)
    return (
      <div className="boot-screen">
        <Brand />
        <span className="loader" />
        <p>Making a little room for perspective…</p>
      </div>
    );
  if (!auth)
    return (
      <>
        {authError && (
          <div className="auth-error-banner">
            <ErrorBox message={authError} retry={loadAuth} />
          </div>
        )}
        <Auth onSuccess={authenticate} />
      </>
    );
  const activeCount = trades.filter((t) => t.status === 'OPEN' || t.status === 'PENDING').length;
  const feed = account?.feed;
  const isFixture = feed?.provider === 'fixture';
  const unhealthy =
    feed &&
    !['HEALTHY', 'IDLE', 'RUNNING', 'OK', 'READY', 'STARTING', 'SYNCING'].includes(
      feed.status.toUpperCase(),
    );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a href="#overview" className="sidebar-brand" aria-label="Paperlane overview">
          <Brand />
        </a>
        <div className="workspace-label">YOUR PRACTICE SPACE</div>
        <nav aria-label="Main navigation">
          {navigation.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => navigate(id)}
              aria-current={page === id ? 'page' : undefined}
              className={`nav-link ${page === id ? 'active' : ''}`}
            >
              <Icon size={19} strokeWidth={1.8} />
              <span>{label}</span>
              {id === 'overview' && activeCount > 0 && (
                <span className="nav-count">{activeCount}</span>
              )}
              {page === id && <span className="nav-active-dot" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="practice-note">
            <span className="practice-icon">
              <Leaf size={21} />
            </span>
            <h3>
              Small steps.
              <br />
              Thoughtful progress.
            </h3>
            <p>A space to grow your trading confidence, at your own pace.</p>
            <span>
              <i /> NO REAL MONEY INVOLVED
            </span>
          </div>
          <div className="sidebar-user">
            <span className="user-avatar">{auth.user.username.slice(0, 2).toUpperCase()}</span>
            <div>
              <strong>{auth.user.username}</strong>
              <small>Personal account</small>
            </div>
            <button className="icon-button" aria-label="Log out" onClick={logout}>
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <span>My workspace</span>
            <ChevronRight size={13} />
            <strong>{navigation.find((n) => n.id === page)?.label}</strong>
          </div>
          <div className="topbar-right">
            <span className={`feed-badge ${unhealthy ? 'feed-warning' : ''}`}>
              <i />
              {isFixture ? 'Test data' : 'Delayed data'}
            </span>
            <span className="market-badge">
              <span className={account?.marketOpen ? 'market-dot open' : 'market-dot'} />
              {feed?.status === 'CALENDAR_REQUIRED'
                ? 'Calendar needed'
                : account?.marketOpen
                  ? 'Market open'
                  : 'Market closed'}
            </span>
            <button
              className="icon-button refresh-button"
              disabled={refreshing}
              onClick={() => void refresh()}
              title={
                lastUpdated
                  ? `Updated ${lastUpdated.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`
                  : 'Refresh account'
              }
              aria-label="Refresh account"
            >
              <RefreshCw size={16} className={refreshing ? 'spinning' : ''} />
            </button>
            <span className="topbar-avatar">{auth.user.username.slice(0, 1).toUpperCase()}</span>
          </div>
        </header>
        <main className="main-content" id="main-content">
          {error && <ErrorBox message={error} retry={() => void refresh()} />}
          {account?.hasStaleMarks && (
            <div className="feed-status-notice">
              <Clock3 size={17} />
              <span>
                Some holdings use an older quote or their entry price. Equity is an estimate until
                usable market marks return.
              </span>
            </div>
          )}
          {unhealthy && (
            <div className="feed-status-notice">
              <Clock3 size={17} />
              <span>
                <strong>
                  {feed.status
                    .replaceAll('_', ' ')
                    .toLowerCase()
                    .replace(/^./, (s) => s.toUpperCase())}
                  .
                </strong>{' '}
                {feed.message ||
                  'Prices are not currently updating. Trading waits for usable market data.'}
              </span>
            </div>
          )}
          {!account ? (
            <div className="loading-block account-loading">
              <span className="loader" />
              Opening your practice space…
            </div>
          ) : page === 'overview' ? (
            <Dashboard
              account={account}
              trades={trades}
              curve={curve}
              stats={stats}
              username={auth.user.username}
              navigate={navigate}
              onSelect={setSelected}
            />
          ) : page === 'trade' ? (
            <TradeForm
              account={account}
              onCreated={(trade) => {
                if (activeAuth.current?.accountId !== auth.accountId) return;
                changed(`${trade.symbol} order placed. Your idea is in motion.`);
                navigate('overview');
                setSelected(trade.id);
              }}
            />
          ) : page === 'journal' ? (
            <Journal revision={revision} onSelect={setSelected} onNew={() => navigate('trade')} />
          ) : page === 'insights' ? (
            <Insights revision={revision} curve={curve} />
          ) : (
            <Settings account={account} username={auth.user.username} onChanged={changed} />
          )}
        </main>
        <footer className="app-footer">
          <span>
            <ShieldCheck size={14} />A little practice. A lot of perspective.
          </span>
          <span>
            Paper trading only<span className="footer-dot">·</span>NSE equities
            <span className="footer-dot">·</span>All times IST
          </span>
        </footer>
      </div>
      <nav className="mobile-nav" aria-label="Mobile navigation">
        {navigation.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={page === id ? 'active' : ''}
            onClick={() => navigate(id)}
            aria-current={page === id ? 'page' : undefined}
          >
            <Icon size={20} />
            <span>{label === 'Overview' ? 'Home' : label}</span>
          </button>
        ))}
        <button onClick={logout} aria-label="Log out">
          <LogOut size={20} />
          <span>Log out</span>
        </button>
      </nav>
      {selected && account && (
        <TradeDetail
          id={selected}
          onClose={() => setSelected(null)}
          onChanged={changed}
          marketOpen={account.marketOpen}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          <span>
            <Check size={17} />
          </span>
          <p>{toast}</p>
          <button aria-label="Dismiss notification" onClick={() => setToast('')}>
            <X size={17} />
          </button>
        </div>
      )}
    </div>
  );
}
