"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { CoachPanel } from "@/components/coach-panel";
import { FormTrendChart } from "@/components/form-trend-chart";
import { Icon } from "@/components/icon";
import { MetricCard } from "@/components/metric-card";
import { ScoreRing } from "@/components/score-ring";
import { SessionDetail as SessionDetailCard } from "@/components/session-detail";
import { SessionList } from "@/components/session-list";
import {
  ApiAccessDeniedError,
  ApiAuthenticationError,
  loadDashboard,
  loadSessionDetail,
} from "@/lib/api";
import {
  demoIdentity,
  logout,
  readCognitoIdentity,
  startCognitoLogin,
  type DashboardIdentity,
} from "@/lib/auth";
import { getDemoSessionDetail } from "@/lib/demo-data";
import { formatScore, formatSessionTime, scoreDescriptor } from "@/lib/format";
import {
  loadRuntimeConfig,
  runtimeConfigIsReady,
  type RuntimeConfig,
} from "@/lib/runtime-config";
import type { DashboardData, SessionDetail } from "@/lib/types";

const weeklyDays = ["M", "T", "W", "T", "F", "S", "S"];

type DashboardPhase = "booting" | "configuration" | "sign-in" | "outage" | "ready";

interface StateScreenProps {
  eyebrow: string;
  title: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  secondaryLabel?: string;
  onSecondaryAction?: () => void;
}

function StateScreen({
  eyebrow,
  title,
  message,
  actionLabel,
  onAction,
  secondaryLabel,
  onSecondaryAction,
}: StateScreenProps) {
  return (
    <main className="auth-screen">
      <section className="auth-card" aria-live="polite">
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p>{message}</p>
        {actionLabel && onAction ? (
          <button className="auth-primary-action" type="button" onClick={onAction}>
            {actionLabel}
          </button>
        ) : null}
        {secondaryLabel && onSecondaryAction ? (
          <button className="auth-secondary-action" type="button" onClick={onSecondaryAction}>
            {secondaryLabel}
          </button>
        ) : null}
      </section>
    </main>
  );
}

function userInitials(userId: string): string {
  return (
    userId
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map((part) => part[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || "RC"
  );
}

function scoreChange(data: DashboardData): string | undefined {
  const points = data.summary.form_trend;
  if (points.length < 2) return undefined;
  const change = points[points.length - 1].average_score - points[0].average_score;
  return change > 0 ? `+${change.toFixed(1)}` : undefined;
}

function issueMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "The dashboard could not reach RepCoach.";
}

export function Dashboard() {
  const [phase, setPhase] = useState<DashboardPhase>("booting");
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfig | null>(null);
  const [identity, setIdentity] = useState<DashboardIdentity | null>(null);
  const [data, setData] = useState<DashboardData | null>(null);
  const [selectedSession, setSelectedSession] = useState<SessionDetail | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [issue, setIssue] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isDetailLoading, setIsDetailLoading] = useState(false);

  const signOutForExpiredSession = useCallback(() => {
    setIdentity(null);
    setData(null);
    setSelectedSession(null);
    setPhase("sign-in");
  }, []);

  const loadAthleteData = useCallback(
    async (config: RuntimeConfig) => {
      setIsRefreshing(true);
      setIssue(null);
      try {
        const next = await loadDashboard({ config });
        setData(next);
        setSelectedSession(next.latestSession);
        setSelectedSessionId(next.latestSession?.id ?? next.summary.recent_sessions[0]?.id ?? null);
        setPhase("ready");
      } catch (error) {
        setData(null);
        setSelectedSession(null);
        if (error instanceof ApiAuthenticationError || error instanceof ApiAccessDeniedError) {
          signOutForExpiredSession();
          return;
        }
        setIssue(issueMessage(error));
        setPhase("outage");
      } finally {
        setIsRefreshing(false);
      }
    },
    [signOutForExpiredSession],
  );

  const bootstrap = useCallback(async () => {
    setPhase("booting");
    setIssue(null);
    try {
      const config = await loadRuntimeConfig();
      setRuntimeConfig(config);
      if (!runtimeConfigIsReady(config)) {
        setPhase("configuration");
        return;
      }
      const athlete = config.demoMode ? demoIdentity(config) : await readCognitoIdentity();
      if (!athlete) {
        setPhase("sign-in");
        return;
      }
      setIdentity(athlete);
      await loadAthleteData(config);
    } catch (error) {
      setIssue(issueMessage(error));
      setPhase("outage");
    }
  }, [loadAthleteData]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  const refresh = useCallback(() => {
    if (runtimeConfig && identity) void loadAthleteData(runtimeConfig);
  }, [identity, loadAthleteData, runtimeConfig]);

  const selectSession = async (sessionId: string) => {
    if (!data) return;
    setSelectedSessionId(sessionId);
    if (data.usingDemoData) {
      setSelectedSession(getDemoSessionDetail(sessionId));
      return;
    }
    if (sessionId === data.latestSession?.id) {
      setSelectedSession(data.latestSession);
      return;
    }
    setIsDetailLoading(true);
    try {
      setSelectedSession(await loadSessionDetail(sessionId));
    } catch (error) {
      if (error instanceof ApiAuthenticationError || error instanceof ApiAccessDeniedError) {
        signOutForExpiredSession();
      } else {
        setIssue(issueMessage(error));
        setPhase("outage");
      }
    } finally {
      setIsDetailLoading(false);
    }
  };

  const bestTrendScore = useMemo(
    () => data?.summary.form_trend.reduce((highest, point) => Math.max(highest, point.average_score), 0) ?? 0,
    [data],
  );

  if (phase === "booting") {
    return <StateScreen eyebrow="RepCoach" title="Preparing your dashboard" message="Checking your secure training session…" />;
  }
  if (phase === "configuration") {
    return <StateScreen eyebrow="RepCoach deployment" title="Sign-in is not configured" message="This dashboard cannot use demo data in this environment. Configure the production Cognito and API runtime settings, then reload." actionLabel="Reload" onAction={() => void bootstrap()} />;
  }
  if (phase === "sign-in") {
    return <StateScreen eyebrow="RepCoach" title="Your training, securely connected" message="Sign in to view your workout history, form trends, and coaching feedback." actionLabel="Sign in with RepCoach" onAction={startCognitoLogin} />;
  }
  if (phase === "outage") {
    return <StateScreen eyebrow="RepCoach availability" title="Your dashboard is temporarily unavailable" message={issue ?? "Please try again in a moment. No demo data is shown outside local demo mode."} actionLabel="Try again" onAction={() => void bootstrap()} secondaryLabel="Sign out" onSecondaryAction={logout} />;
  }
  if (!data || !runtimeConfig || !identity) {
    return <StateScreen eyebrow="RepCoach" title="Preparing your dashboard" message="Checking your secure training session…" />;
  }

  const formScore = data.summary.average_form_score;
  const currentTrend = scoreChange(data);
  const weeklyGoal = Math.max(80, Math.ceil(data.summary.weekly_reps / 20) * 20);
  const weeklyProgress = Math.min(100, (data.summary.weekly_reps / weeklyGoal) * 100);
  const syncLabel = data.usingDemoData ? "Demo preview" : "Live data";
  const profileLabel = identity.kind === "demo" ? "Demo athlete" : "Signed-in athlete";

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand" aria-label="RepCoach home">
          <span className="brand__mark"><span /><span /><span /></span>
          <span>rep<span>coach</span></span>
        </div>
        <nav className="sidebar__nav" aria-label="Dashboard navigation">
          <a className="sidebar__nav-item sidebar__nav-item--current" href="#overview"><Icon name="activity" size={19} />Overview</a>
          <a className="sidebar__nav-item" href="#sessions"><Icon name="calendar" size={19} />Workouts</a>
          <a className="sidebar__nav-item" href="#form-analysis"><Icon name="target" size={19} />Form analysis</a>
          <a className="sidebar__nav-item" href="#coach"><Icon name="sparkles" size={19} />Coach</a>
        </nav>
        <div className="sidebar__bottom">
          <div className="sidebar__goal">
            <span className="sidebar__goal-icon"><Icon name="flame" size={17} /></span>
            <div><strong>{data.summary.current_streak_days} day streak</strong><small>Keep your momentum</small></div>
          </div>
          <button className="profile-button" type="button" onClick={logout} aria-label="Sign out">
            <span className="profile-button__avatar">{userInitials(identity.userId)}</span>
            <span><strong>{profileLabel}</strong><small>Sign out</small></span>
            <Icon name="chevron-right" size={16} />
          </button>
        </div>
      </aside>

      <section className="dashboard-content" id="overview">
        <header className="dashboard-header">
          <div>
            <p className="eyebrow">Movement intelligence</p>
            <h1>Good morning, athlete.</h1>
            <p className="dashboard-header__subtitle">Your form is trending <strong>upward</strong>. Let&apos;s make today&apos;s reps count.</p>
          </div>
          <div className="dashboard-header__actions">
            <span className={`api-status ${data.usingDemoData ? "api-status--demo" : ""}`}><i />{syncLabel}</span>
            <button className="icon-button" type="button" onClick={refresh} disabled={isRefreshing} aria-label="Refresh dashboard data"><Icon name="refresh" size={18} className={isRefreshing ? "spin" : ""} /></button>
            <button className="start-button" type="button" onClick={() => document.getElementById("sessions")?.scrollIntoView({ behavior: "smooth" })}><Icon name="play" size={16} />Review workout</button>
          </div>
        </header>

        {data.usingDemoData ? <div className="demo-notice"><Icon name="info" size={16} /><span>{data.message ?? "Showing representative demo data."}</span></div> : null}

        <section className="hero-grid" aria-label="Training summary">
          <article className="live-card">
            <div className="live-card__glow" />
            <div className="live-card__body">
              <div className="live-card__badge"><i />SESSION READY</div>
              <h2>Train with a coach<br />that sees the details.</h2>
              <p>Use the mobile app for real-time rep counting and pose-guided form cues.</p>
              <div className="live-card__actions"><button type="button"><Icon name="camera" size={17} />Open mobile coach</button><span><Icon name="clock" size={15} />About 12 min</span></div>
            </div>
            <div className="pose-preview" aria-hidden="true">
              <span className="pose-preview__joint pose-preview__joint--head" />
              <span className="pose-preview__joint pose-preview__joint--shoulder" />
              <span className="pose-preview__joint pose-preview__joint--hip" />
              <span className="pose-preview__joint pose-preview__joint--knee" />
              <span className="pose-preview__joint pose-preview__joint--ankle" />
              <i className="pose-preview__line pose-preview__line--torso" /><i className="pose-preview__line pose-preview__line--thigh" /><i className="pose-preview__line pose-preview__line--shin" />
              <div className="pose-preview__score"><span>LIVE FORM</span><strong>92</strong><small>excellent</small></div>
            </div>
          </article>

          <article className="weekly-card">
            <div className="weekly-card__heading"><div><p className="eyebrow">This week</p><h2>{data.summary.weekly_reps} reps</h2></div><span className="weekly-card__badge">{Math.round(weeklyProgress)}% goal</span></div>
            <div className="weekly-card__progress"><span style={{ width: `${weeklyProgress}%` }} /></div>
            <p className="weekly-card__goal-label">{Math.max(0, weeklyGoal - data.summary.weekly_reps)} reps to your weekly movement goal</p>
            <div className="weekly-days" aria-label="Weekly training cadence">
              {weeklyDays.map((day, index) => <span className={index < Math.min(weeklyDays.length, Math.ceil(data.summary.weekly_reps / 12)) ? "weekly-days__day weekly-days__day--done" : "weekly-days__day"} key={`${day}-${index}`}><i>{index < Math.min(weeklyDays.length, Math.ceil(data.summary.weekly_reps / 12)) ? <Icon name="check" size={12} /> : null}</i>{day}</span>)}
            </div>
          </article>
        </section>

        <section className="metrics-grid" aria-label="Key performance indicators">
          <MetricCard label="Average form" value={formatScore(formScore)} detail={scoreDescriptor(formScore)} icon="target" accent="mint" trend={currentTrend} />
          <MetricCard label="Weekly volume" value={data.summary.weekly_reps.toString()} detail="reps tracked this week" icon="zap" accent="violet" trend={`${Math.max(1, data.summary.recent_sessions.length)} sessions`} />
          <MetricCard label="Current streak" value={`${data.summary.current_streak_days} days`} detail="your longest is 8 days" icon="flame" accent="amber" />
          <MetricCard label="Training days" value={data.summary.total_sessions.toString()} detail="sessions in your history" icon="calendar" accent="sky" />
        </section>

        <section className="insights-grid">
          <article className="surface-card trend-panel" id="form-analysis">
            <div className="surface-card__heading">
              <div><p className="eyebrow">Form quality</p><h2>Movement trend</h2></div>
              <div className="trend-panel__summary"><Icon name="trend" size={17} /><span><strong>{bestTrendScore ? formatScore(bestTrendScore) : "—"}</strong> best this week</span></div>
            </div>
            <FormTrendChart points={data.summary.form_trend} />
            <div className="trend-panel__footer"><span><i className="legend-dot legend-dot--mint" />Average rep score</span><span>Scores update as analysis workers complete.</span></div>
          </article>

          <article className="surface-card score-summary">
            <div className="surface-card__heading"><div><p className="eyebrow">Today&apos;s signal</p><h2>Form is holding strong</h2></div><button type="button" aria-label="More about form score"><Icon name="info" size={17} /></button></div>
            <div className="score-summary__center"><ScoreRing score={formScore} /><div><strong>{scoreDescriptor(formScore)}</strong><p>Across {data.summary.total_reps} analyzed reps</p></div></div>
            <div className="quality-meter"><div><span>Depth</span><strong>91%</strong></div><i><b style={{ width: "91%" }} /></i><div><span>Alignment</span><strong>88%</strong></div><i><b style={{ width: "88%" }} /></i><div><span>Tempo</span><strong>84%</strong></div><i><b style={{ width: "84%" }} /></i></div>
          </article>
        </section>

        <section className="lower-grid">
          <article className="surface-card sessions-panel" id="sessions">
            <div className="surface-card__heading"><div><p className="eyebrow">Workout history</p><h2>Recent sessions</h2></div><span className="sessions-panel__count">{data.summary.recent_sessions.length} latest</span></div>
            <SessionList sessions={data.summary.recent_sessions} activeSessionId={selectedSessionId} onSelect={(id) => void selectSession(id)} />
            <button className="text-action" type="button">View full history <Icon name="arrow-up-right" size={15} /></button>
          </article>

          <article className={`surface-card selected-session-panel ${isDetailLoading ? "selected-session-panel--loading" : ""}`}>
            {isDetailLoading ? <div className="detail-loading"><Icon name="refresh" size={20} className="spin" />Loading rep signals…</div> : <SessionDetailCard session={selectedSession} />}
          </article>
        </section>

        <section id="coach"><CoachPanel cue={data.summary.common_cue} score={formScore} allowDemoFallback={runtimeConfig.demoMode} onAuthenticationError={signOutForExpiredSession} /></section>

        <footer className="dashboard-footer">Last updated {formatSessionTime(data.summary.generated_at)} · Pose landmarks only; no workout video is stored by default.</footer>
      </section>
    </main>
  );
}
