import { useEffect, useRef } from 'react';
import { createChart, CandlestickSeries, HistogramSeries, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';

export interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number; synthetic: boolean }

export function PriceChart({ candles, ticker }: { candles: Candle[]; ticker: string }) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi>(undefined);
  const cs = useRef<ISeriesApi<'Candlestick'>>(undefined);
  const vs = useRef<ISeriesApi<'Histogram'>>(undefined);
  const fitted = useRef('');

  useEffect(() => {
    if (!el.current) return;
    const c = createChart(el.current, {
      autoSize: true,
      layout: { background: { color: '#ffffff' }, textColor: '#5b6b84', fontFamily: 'Archivo Variable, system-ui', fontSize: 11 },
      grid: { vertLines: { color: '#eef1f5' }, horzLines: { color: '#eef1f5' } },
      rightPriceScale: { borderColor: '#cdd4de' },
      timeScale: { borderColor: '#cdd4de', timeVisible: true },
      crosshair: { mode: 1 },
    });
    cs.current = c.addSeries(CandlestickSeries, { upColor: '#0f7a66', downColor: '#b8364a', borderVisible: false, wickUpColor: '#0f7a66', wickDownColor: '#b8364a', priceFormat: { type: 'price', precision: 5, minMove: 0.00001 } });
    vs.current = c.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
    c.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    chart.current = c;
    return () => c.remove();
  }, []);

  useEffect(() => {
    if (!cs.current || !candles?.length) return;
    // synthetic pre-launch history is drawn washed-out so it can't be mistaken for trading
    cs.current.setData(candles.map((k) => ({ time: k.time as UTCTimestamp, open: k.open, high: k.high, low: k.low, close: k.close, ...(k.synthetic ? { color: '#c9d1dd', wickColor: '#c9d1dd' } : {}) })));
    vs.current!.setData(candles.map((k) => ({ time: k.time as UTCTimestamp, value: k.volume, color: k.synthetic ? '#e3e8ee' : k.close >= k.open ? '#9fd3c7' : '#ebb3bc' })));
    if (fitted.current !== ticker) { chart.current!.timeScale().fitContent(); fitted.current = ticker; }
  }, [candles, ticker]);

  return <div ref={el} className="chart" role="img" aria-label={`${ticker} price chart`} />;
}
