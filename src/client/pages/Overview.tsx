import { useEffect, useRef, useState } from 'react';
import { Badge, Card, Notice } from '../components/ui.js';
import { Gauge } from '../components/Gauge.js';
import { Mono } from '../components/Ltr.js';
import { Time } from '../components/Time.js';
import { useLocale } from '../i18n/index.js';
import { api, ApiError } from '../lib/api.js';
import { formatBytes, formatDuration, formatPercent } from '../lib/format.js';
import type { MetricsResponse, WatchdogRuleStatus } from '../../shared/types.js';

/**
 * The resource widget: the thing the operator asked for, and the one screen whose whole job is
 * to be honest about what it does not know.
 *
 * ── The poll budget, which is not negotiable ────────────────────────────────
 *
 * Two seconds while the tab is visible, thirty while it is hidden, and **nothing at all** when
 * it is closed. Two seconds is 30 requests a minute against a session bucket that holds 120 and
 * refills 240 a minute, so the widget uses an eighth of the refill and never touches the
 * capacity — three tabs at two seconds is still inside it.
 *
 * The thirty-second hidden cadence is not only politeness. It sits **above** the sampler's own
 * 1000 ms cadence and **below** its 60 s idle timeout, so a hidden tab keeps the sampler warm
 * and `cpu.percentOfQuota` stays a number instead of going back to `null` on every poll. An
 * operator who leaves the panel in a background tab for a week must not generate 30 requests a
 * minute for a week.
 *
 * ── Four states that are not numbers, and each renders as words ─────────────
 *
 * 1. `cpu.percentOfQuota === null` — a rate needs two samples. "Measuring", never 0 %.
 * 2. `memory.limitBytes === null` — the container reports no limit, so there is no denominator.
 *    A sentence, never a full bar and never an empty one.
 * 3. `meta.source === 'os'` — the cgroup could not be read and these figures describe the
 *    **host**. Said on screen, because a silently host-wide memory gauge is worse than none.
 * 4. A disarmed watchdog rule — off is not healthy, and the reason code says which.
 */

const VISIBLE_MS = 2_000;
const HIDDEN_MS = 30_000;

export function Overview(): React.JSX.Element {
  const { t, ts, locale } = useLocale();
  const [metrics, setMetrics] = useState<MetricsResponse | null>(null);
  const [error, setError] = useState<React.ReactNode | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    const poll = async (): Promise<void> => {
      try {
        const next = await api.get<MetricsResponse>('/api/metrics');
        if (!cancelled) {
          setMetrics(next);
          setError(null);
        }
      } catch (err) {
        if (cancelled) return;
        // A 429 here is the widget's own fault and is not worth a red banner: the next poll is
        // two seconds away and the bucket refills at four a second. Anything else is reported.
        if (err instanceof ApiError && err.status === 429) return;
        setError(t('error.network'));
      }
    };

    const schedule = (): void => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      const delay = document.visibilityState === 'hidden' ? HIDDEN_MS : VISIBLE_MS;
      timer.current = window.setTimeout(() => {
        void poll().then(schedule);
      }, delay);
    };

    // A `setTimeout` chain rather than `setInterval`, so a slow response cannot queue a second
    // request behind the first — which is how a widget on a struggling panel becomes the reason
    // it is struggling.
    void poll().then(schedule);

    const onVisibility = (): void => {
      // Re-poll immediately on becoming visible: the operator has just looked, and a two-second-
      // old figure is fine while a thirty-second-old one looks frozen.
      if (document.visibilityState === 'visible') void poll();
      schedule();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      if (timer.current !== null) window.clearTimeout(timer.current);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [t]);

  if (metrics === null) {
    return (
      <>
        <h1>{t('nav.overview')}</h1>
        {error === null ? <p className="lede">{t('common.loading')}</p> : <Notice kind="danger">{error}</Notice>}
      </>
    );
  }

  const { memory, cpu, disk, meta, watchdog } = metrics;
  const memoryFraction =
    memory.limitBytes !== null && memory.limitBytes > 0 ? memory.usedBytes / memory.limitBytes : null;
  const diskFraction = disk.totalBytes > 0 ? (disk.totalBytes - disk.availableBytes) / disk.totalBytes : null;

  return (
    <>
      <h1>{t('nav.overview')}</h1>
      <p className="lede">
        {t('resources.sampledAt', { time: <Time iso={meta.sampledAt} precision="second" /> })}
      </p>

      {error === null ? null : <Notice kind="warn">{error}</Notice>}

      {/* The `os` fallback. Not a footnote: every figure below describes the host, and the host
          has far more memory than this container may use — which is exactly the shape of the
          `os.totalmem()` mistake the server side exists to avoid. */}
      {meta.source === 'os' ? <Notice kind="warn">{t('resources.hostWide')}</Notice> : null}

      <Card title={t('resources.memory')}>
        {memoryFraction === null ? (
          <>
            <p>{t('resources.noLimit')}</p>
            <p className="row">
              <Mono>{formatBytes(memory.usedBytes, locale)}</Mono>
            </p>
          </>
        ) : (
          <div className="metric">
            <Gauge fraction={memoryFraction} label={ts('resources.memory')} />
            <div className="metric-figures">
              <span>
                {t('resources.usedOfLimit', {
                  used: <Mono>{formatBytes(memory.usedBytes, locale)}</Mono>,
                  limit: <Mono>{formatBytes(memory.limitBytes, locale)}</Mono>,
                })}
              </span>
              <Mono>{formatPercent(memoryFraction, locale)}</Mono>
            </div>
          </div>
        )}
        <Rule rule={watchdog.memory} />
      </Card>

      <Card title={t('resources.cpu')}>
        {/* Null until two samples exist. "Measuring", never a fabricated zero: a zero here would
            render an idle panel however busy it is. */}
        {cpu.percentOfQuota === null ? (
          <p>{t('resources.measuring')}</p>
        ) : (
          <div className="metric">
            <Gauge fraction={cpu.percentOfQuota / 100} label={ts('resources.cpu')} />
            <div className="metric-figures">
              <span>
                {t('resources.cpuOfQuota', {
                  percent: <Mono>{formatPercent(cpu.percentOfQuota / 100, locale)}</Mono>,
                  cores: <Mono>{cpu.quotaCores ?? '?'}</Mono>,
                })}
              </span>
              <Mono>
                {cpu.sampleWindowMs === null ? '' : formatDuration(cpu.sampleWindowMs, locale)}
              </Mono>
            </div>
          </div>
        )}
      </Card>

      <Card title={t('resources.disk')}>
        <div className="metric">
          <Gauge fraction={diskFraction} label={ts('resources.disk')} />
          <div className="metric-figures">
            <span>
              {t('resources.usedOfLimit', {
                used: <Mono>{formatBytes(disk.totalBytes - disk.availableBytes, locale)}</Mono>,
                limit: <Mono>{formatBytes(disk.totalBytes, locale)}</Mono>,
              })}
            </span>
            <Mono>{formatPercent(diskFraction, locale)}</Mono>
          </div>
          <p className="hint">
            {t('resources.available', {
              available: <Mono>{formatBytes(disk.availableBytes, locale)}</Mono>,
            })}
          </p>
          <p className="hint">
            {t('resources.database')}: <Mono>{formatBytes(disk.databaseBytes, locale)}</Mono>{' '}
            <Mono>{disk.path}</Mono>
          </p>
        </div>
        <Rule rule={watchdog.disk} />
      </Card>

      <Card title={t('resources.watchdog')}>
        {watchdog.enabled ? null : <Notice kind="warn">{t('resources.watchdogOff')}</Notice>}

        {/* The OOM counter. `null` is not zero — it means no baseline has been read, so the next
            sample adopts the counter instead of announcing every kill that predates this build. */}
        <p>
          {watchdog.oom.baseline
            ? t('resources.oomKills', { count: <Mono>{watchdog.oom.kills ?? 0}</Mono> })
            : t('resources.oomNoBaseline')}
        </p>

        {/* What the run marker said at boot. `checked: false` is a third state — nothing looked —
            and must not be spelled like a clean shutdown. */}
        <p>
          {!watchdog.previousRun.checked
            ? t('resources.notChecked')
            : watchdog.previousRun.cleanShutdown === true
              ? t('resources.cleanRestart')
              : t('resources.uncleanRestart', {
                  time: <Time iso={watchdog.previousRun.detail?.lastSeenAt ?? null} />,
                  used: <Mono>{formatBytes(watchdog.previousRun.detail?.usedBytes ?? null, locale) ?? '—'}</Mono>,
                })}
        </p>

        {/* The watchdog's own CPU window, which is how the two consumers of the resource readers
            stay distinguishable from outside the process: this is its 30 s cadence and the
            figure in the CPU card above is the sampler's second. */}
        <p className="hint">
          {t('resources.sampledAt', {
            time: <Time iso={watchdog.sampledAt} precision="second" />,
          })}{' '}
          <Mono>
            {watchdog.cpuSampleWindowMs === null
              ? ''
              : formatDuration(watchdog.cpuSampleWindowMs, locale)}
          </Mono>
        </p>
      </Card>
    </>
  );
}

/**
 * One threshold rule's state, in words.
 *
 * A disarmed rule is **off, not healthy**, and the reason is a code from a closed set that this
 * maps to a sentence — which is the whole reason the server sends codes rather than prose.
 */
function Rule({ rule }: { rule: WatchdogRuleStatus }): React.JSX.Element {
  const { t, locale } = useLocale();

  if (!rule.armed) {
    const key =
      rule.reason === 'no_limit'
        ? 'resources.disarmedNoLimit'
        : rule.reason === 'disabled'
          ? 'resources.disarmedDisabled'
          : 'resources.disarmedUnavailable';
    return (
      <p className="row">
        <Badge kind="warn">{t('resources.watchdog')}</Badge> {t(key)}
      </p>
    );
  }

  return (
    <div>
      <p className="row">
        <Badge kind={rule.state === 'above' ? 'danger' : 'ok'}>{t('resources.watchdog')}</Badge>{' '}
        {t('resources.armed', { threshold: <Mono>{rule.thresholdPercent}%</Mono> })}
      </p>
      {rule.state === 'above' ? (
        <p className="hint">
          {t('resources.above', {
            time: <Time iso={rule.alertedAt} />,
          })}
        </p>
      ) : null}
      {/* The recovery debounce, visible. While this is set the rule is still `above` and the
          operator's last message still describes it correctly — which is the invariant M2.1
          moved the window to buy. */}
      {rule.clearingSince === null ? null : (
        <p className="hint">
          {t('resources.clearing', {
            time: <Time iso={rule.clearingSince} />,
            window: <Mono>{formatDuration(30 * 60_000, locale)}</Mono>,
          })}
        </p>
      )}
    </div>
  );
}
