import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../lib/api';
import { backtestApi } from './api';
import type { Run, Trade } from './types';

const isLive = (r: Run | null) => r?.status === 'queued' || r?.status === 'running';

/** One run, polled every second while it is still running. */
export function useRun(id: string) {
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number>();

  const load = useCallback(async () => {
    try {
      const r = await backtestApi.run(id);
      setRun(r);
      setError(null);
      if (isLive(r)) timer.current = window.setTimeout(load, 1_000);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load this backtest.');
    }
  }, [id]);

  useEffect(() => {
    load();
    return () => window.clearTimeout(timer.current);
  }, [load]);

  return { run, error, reload: load };
}

/** Every trade of a completed run, in entry order. Fetched once. */
export function useTrades(run: Run | null) {
  const [trades, setTrades] = useState<Trade[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const id = run?._id;
  const done = run?.status === 'completed';

  useEffect(() => {
    if (!id || !done) return;
    let cancelled = false;
    backtestApi
      .trades(id)
      .then((t) => !cancelled && setTrades(t))
      .catch((e) => !cancelled && setError(e instanceof ApiError ? e.message : 'Could not load trades.'));
    return () => {
      cancelled = true;
    };
  }, [id, done]);

  return { trades, error };
}

/** All runs, polled every two seconds while any is still running. */
export function useRuns() {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number>();

  const load = useCallback(async () => {
    window.clearTimeout(timer.current);
    try {
      const list = await backtestApi.runs();
      setRuns(list);
      setError(null);
      if (list.some(isLive)) timer.current = window.setTimeout(load, 2_000);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load backtests.');
    }
  }, []);

  useEffect(() => {
    load();
    return () => window.clearTimeout(timer.current);
  }, [load]);

  return { runs, error, reload: load };
}
