"""Use Optuna TPE to maximize P&L of an explicit five-feature entry rule."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import numpy as np
import optuna
import pandas as pd

from train_screening import load_data, portfolio, temporal_split

PRECISION = {'poolQuotePrincipalUsd': 2, 'quotePrincipalToPoolSize': 6, 'top1HolderShare': 6, 'marketCapUsd': 2}
FIELDS = ['poolQuotePrincipalUsd', 'quotePrincipalToPoolSize', 'top1HolderShare', 'observedPoolFeePips', 'marketCapUsd']


def apply_rule(data: pd.DataFrame, rule: dict[str, Any]) -> np.ndarray:
    data = data[FIELDS].round(PRECISION)
    quote = data.poolQuotePrincipalUsd.to_numpy(dtype=float)
    ratio = data.quotePrincipalToPoolSize.to_numpy(dtype=float)
    holder = data.top1HolderShare.to_numpy(dtype=float)
    fee = data.observedPoolFeePips.to_numpy(dtype=float)
    cap = data.marketCapUsd.to_numpy(dtype=float)
    return ((quote >= rule['usdcMin']) & (ratio >= rule['usdcShareMin']) & (ratio <= rule['usdcShareMax'])
            & ((holder <= rule['holderMax']) | (np.isnan(holder) & rule['allowMissingHolder']))
            & ((fee <= rule['feeMaxPips']) | (np.isnan(fee) & rule['allowMissingFee']))
            & (cap >= rule['marketCapMin']) & (cap <= rule['marketCapMax']))


def optimize(data: pd.DataFrame, trials: int, seed: int, name: str, output: Path) -> dict[str, Any]:
    rounded = data[FIELDS].round(PRECISION)
    values = {field: np.sort(rounded[field].dropna().to_numpy(dtype=float)) for field in FIELDS}
    fees = np.unique(values['observedPoolFeePips']).tolist()
    quantile = lambda field, value: round(float(np.quantile(values[field], value)), PRECISION.get(field, 0))
    def objective(trial: optuna.Trial) -> float:
        ratio = sorted([trial.suggest_float('shareA', 0, 1), trial.suggest_float('shareB', 0, 1)])
        cap = sorted([trial.suggest_float('capA', 0, 1), trial.suggest_float('capB', 0, 1)])
        rule = {'usdcMin': quantile('poolQuotePrincipalUsd', trial.suggest_float('usdcMinQuantile', 0, 1)),
                'usdcShareMin': quantile('quotePrincipalToPoolSize', ratio[0]),
                'usdcShareMax': quantile('quotePrincipalToPoolSize', ratio[1]),
                'holderMax': quantile('top1HolderShare', trial.suggest_float('holderMaxQuantile', 0, 1)),
                'feeMaxPips': float(trial.suggest_categorical('feeMaxPips', fees)),
                'marketCapMin': quantile('marketCapUsd', cap[0]),
                'marketCapMax': quantile('marketCapUsd', cap[1]),
                'allowMissingHolder': trial.suggest_categorical('allowMissingHolder', [False, True]),
                'allowMissingFee': trial.suggest_categorical('allowMissingFee', [False, True])}
        keep = apply_rule(data, rule)
        trial.set_user_attr('rule', rule)
        trial.set_user_attr('entriesKept', int(keep.sum()))
        return float(data.netUsd.to_numpy()[keep].sum())
    study = optuna.create_study(direction='maximize', sampler=optuna.samplers.TPESampler(seed=seed, n_startup_trials=100))
    study.enqueue_trial({'shareA': 0, 'shareB': 1, 'capA': 0, 'capB': 1, 'usdcMinQuantile': 0,
                         'holderMaxQuantile': 1, 'feeMaxPips': fees[-1], 'allowMissingHolder': True, 'allowMissingFee': True})
    def progress(study: optuna.Study, trial: optuna.trial.FrozenTrial) -> None:
        if (trial.number + 1) % 500 == 0:
            print(json.dumps({'study': name, 'trials': trial.number + 1, 'bestPnlUsd': study.best_value}), flush=True)
    study.optimize(objective, n_trials=trials, callbacks=[progress])
    study.trials_dataframe().to_csv(output / f'{name}-trials.csv', index=False)
    return {'rule': study.best_trial.user_attrs['rule'], 'bestTrial': study.best_trial.number,
            'fitPnlUsd': study.best_value, 'trials': len(study.trials), 'seed': seed,
            'progress': [{'trial': trial.number, 'pnl': trial.value} for trial in study.trials
                         if trial.number % 500 == 0 or trial.number == study.best_trial.number]}


def evaluate(data: pd.DataFrame, rule: dict[str, Any]) -> dict[str, Any]:
    keep = apply_rule(data, rule)
    results = portfolio(data, ~keep)
    results['profitPerEntryUsd'] = results['netUsdKept'] / results['entriesKept'] if results['entriesKept'] else None
    return results


def formula(rule: dict[str, Any]) -> str:
    missing_holder = ' OR holder share unavailable' if rule['allowMissingHolder'] else ''
    missing_fee = ' OR pool fee unavailable' if rule['allowMissingFee'] else ''
    return '\n'.join([f"USDC-side pool principal >= ${rule['usdcMin']:.10g}",
        f"{rule['usdcShareMin']:.10g} <= USDC principal / pool value <= {rule['usdcShareMax']:.10g}",
        f"Largest holder share <= {rule['holderMax']:.10g}{missing_holder}",
        f"Observed pool fee <= {rule['feeMaxPips']:.10g} pips ({rule['feeMaxPips']/10000:.4g}%){missing_fee}",
        f"${rule['marketCapMin']:.10g} <= market cap <= ${rule['marketCapMax']:.10g}"])


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--report', required=True, type=Path)
    parser.add_argument('--trials', default=5000, type=int)
    parser.add_argument('--seed', default=42, type=int)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    optuna.logging.set_verbosity(optuna.logging.WARNING)
    data = load_data(args.input)
    split, split_summary = temporal_split(data)
    development = data.loc[split.isin(['train', 'validation'])]
    test = data.loc[split == 'test']
    results = {'optunaVersion': optuna.__version__, 'sampler': 'TPE', 'objective': 'sum of retained netUsd',
               'variant': '+4 blocks / 40% at 2.5x', 'split': split_summary, 'searchSpace': 'AND of USDC lower bound, USDC-share interval, holder upper bound, fee upper bound, market-cap interval; explicit missing-holder/fee choices', 'studies': {}}
    for name, fit in [('development', development), ('full_sample', data)]:
        study = optimize(fit, args.trials, args.seed, name, args.output)
        rule = study['rule']
        study['evaluations'] = {'development': evaluate(development, rule), 'test': evaluate(test, rule), 'fullSample': evaluate(data, rule)}
        study['formula'] = formula(rule)
        results['studies'][name] = study
    results['note'] = 'Development rule is selected before the held-out tail. Full-sample rule maximizes observed 72-hour P&L and its test-subset score is in-sample. Optuna reports the best rule found in this search, not a proven global maximum.'
    (args.output / 'rule-summary.json').write_text(json.dumps(results, indent=2))
    args.report.with_suffix('.json').write_text(json.dumps(results, indent=2))
    args.report.write_text(render_report(results))
    print(json.dumps({name: study['evaluations'] for name, study in results['studies'].items()}), flush=True)


def render_report(results: dict[str, Any]) -> str:
    text = '# Arc explicit five-feature screening rule: Optuna\n\n'
    text += f"+4 blocks / 40% at 2.5x, $2 stake, same fee/gas/tax/failed-exit accounting. Optuna {results['optunaVersion']}, seeded TPE sampler, {results.get('totalTrialsPerStudy', next(iter(results['studies'].values()))['trials']):,} trials per study. Objective: total retained net P&L. Thresholds are continuous quantiles of each study's fit population, converted to explicit numeric bounds; fees use observed discrete values. No grid search. Currency inputs and cuts are rounded to cents, shares to six decimals; this makes printed rules executable without floating-point boundary artifacts.\n\n"
    text += results['note'] + '\n\n'
    for name, study in results['studies'].items():
        text += f"## {name}\n\nBuy only when ALL conditions below hold. OR clauses apply within their individual holder/fee conditions. Values are token-specific at entry, before our purchase.\n\n```text\n{study['formula']}\n```\n\n"
        text += '| Evaluation | Entries kept | Net P&L / baseline | Unknown-blocked P&L | Win rate | Failed exits caught | Heavy losses caught | Loss dollars caught | Winners rejected |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|\n'
        for sample, metrics in study['evaluations'].items():
            pct = lambda value: f'{100*value:.1f}%' if value is not None else '—'
            text += f"| {sample} | {metrics['entriesKept']} | ${metrics['netUsdKept']:.2f} / ${metrics['netUsdBaseline']:.2f} | ${metrics['conservativeNetUsdKept']:.2f} | {pct(metrics['winRateKept'])} | {pct(metrics['failedExitRecall'])} | {pct(metrics['heavyLossRecall'])} | {pct(metrics['lossDollarRecall'])} | {pct(metrics['positivePositionsRejected'])} |\n"
    text += '\nMarket cap is total supply times spot price. Pool value is reconstructed LP principal; USDC principal is its actual quote-side component, distinct from virtual trading reserves. Holder share excludes pool custody and divides by historical total supply. Fee pips: 10,000 = 1%. Heavy losses mean net loss of at least $1. Main optimization labels assume unknown honeypot flags are clear; unknown-blocked P&L is reported separately.\n\nExact thresholds and missing-value choices are in the JSON report. Study trials are retained as local CSV evidence.\n'
    return text


if __name__ == '__main__':
    main()
