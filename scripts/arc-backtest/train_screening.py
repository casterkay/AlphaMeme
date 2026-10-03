"""Train two entry-only LightGBM models and evaluate chronological screening."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import lightgbm as lgb
import numpy as np
import pandas as pd
import sklearn
from sklearn.metrics import average_precision_score, roc_auc_score, precision_score, recall_score, f1_score

CHAIN_FEATURES = [
    'poolAgeBlocks', 'activeVirtualQuoteReserveUsd', 'poolQuotePrincipalUsd',
    'poolSizeUsd', 'liquidityPositionCount', 'marketCapUsd', 'observedPoolFeePips',
    'dynamicFee', 'hasHooks', 'holderCount', 'top1HolderShare', 'top10HolderShare',
    'initialMintRecipientShare', 'priorSwapCount', 'priorBuyCount', 'priorSellCount',
    'priorBuyVolumeUsd', 'priorSellVolumeUsd', 'priorSuccessfulSellers',
    'attributedSellTransactions', 'priorSellRouterCount', 'sellerAttributionCoverage',
    'priceChangeSinceFirstLiquidity',
]


def load_data(directory: Path) -> pd.DataFrame:
    features = pd.DataFrame(json.loads((directory / 'entry-features.json').read_text()))
    features['entryFeatureKey'] = features.token + ':' + features.delayBlocks.astype(str)
    trades = pd.DataFrame(json.loads((directory / 'trades.json').read_text()))
    trades = trades[trades.entered & (trades.delayBlocks == 4) & (trades.policy == '40% at 2.5x')].copy()
    selected = ['entryFeatureKey', *CHAIN_FEATURES, 'venue']
    data = trades.merge(features[selected], on='entryFeatureKey', validate='many_to_one')
    data['isV4'] = (data.venue == 'Uniswap v4').astype(int)
    data['quotePrincipalToPoolSize'] = data.poolQuotePrincipalUsd / data.poolSizeUsd.replace(0, np.nan)
    data['poolSizeToMarketCap'] = data.poolSizeUsd / data.marketCapUsd.replace(0, np.nan)
    return data


def temporal_split(data: pd.DataFrame) -> tuple[pd.Series, dict[str, Any]]:
    times = data.groupby('token').entryTimestamp.min().sort_values()
    validation_start = float(times.iloc[int(len(times) * .6)])
    test_start = float(times.iloc[int(len(times) * .8)])
    first = data.token.map(times)
    last = data.token.map(data.groupby('token').entryTimestamp.max())
    split = pd.Series('purged', index=data.index)
    split.loc[last + 1201 < validation_start] = 'train'
    split.loc[(first >= validation_start) & (last + 1201 < test_start)] = 'validation'
    split.loc[first >= test_start] = 'test'
    return split, {'validationStart': validation_start, 'testStart': test_start,
                   'purgeSeconds': 1201, 'rows': split.value_counts().to_dict(),
                   'tokens': {name: int(data.loc[split == name, 'token'].nunique())
                              for name in ['train', 'validation', 'test', 'purged']}}


def binary_metrics(y: np.ndarray, scores: np.ndarray, threshold: float) -> dict[str, Any]:
    predicted = scores >= threshold
    return {'threshold': float(threshold), 'selected': int(predicted.sum()),
            'accuracy': float((predicted == y).mean()),
            'precision': float(precision_score(y, predicted, zero_division=0)),
            'recall': float(recall_score(y, predicted, zero_division=0)),
            'f1': float(f1_score(y, predicted, zero_division=0)),
            'truePositive': int((predicted & (y == 1)).sum()),
            'falsePositive': int((predicted & (y == 0)).sum()),
            'falseNegative': int((~predicted & (y == 1)).sum())}


def threshold_candidates(y: np.ndarray, scores: np.ndarray) -> list[dict[str, Any]]:
    return [binary_metrics(y, scores, threshold) for threshold in
            np.unique(np.r_[0.0, np.quantile(scores, np.linspace(0, 1, 201)), 1.000001])]


def choose_thresholds(y: np.ndarray, scores: np.ndarray) -> dict[str, float | None]:
    candidates = threshold_candidates(y, scores)
    result: dict[str, float | None] = {'default': .5, 'max_f1': max(candidates, key=lambda x: x['f1'])['threshold']}
    for target in [.8, .9]:
        eligible = [x for x in candidates if x['precision'] >= target and x['selected'] >= 20]
        result[f'precision_{int(target * 100)}'] = max(eligible, key=lambda x: (x['recall'], x['precision']))['threshold'] if eligible else None
    eligible = [x for x in candidates if x['recall'] >= .9]
    result['recall_90'] = max(eligible, key=lambda x: (x['precision'], x['recall']))['threshold']
    return result


def portfolio(data: pd.DataFrame, reject: np.ndarray) -> dict[str, Any]:
    loss = np.maximum(-data.netUsd.to_numpy(), 0)
    failed = data.failedExits.to_numpy() > 0
    severe = data.netUsd.to_numpy() < -.1
    positive = data.netUsd.to_numpy() > 0
    heavy = data.netUsd.to_numpy() <= -1
    fraction = lambda numerator, denominator: float(numerator / denominator) if denominator else None
    kept = data.loc[~reject]
    return {'entriesKept': len(kept), 'entriesRejected': int(reject.sum()),
            'netUsdKept': float(kept.netUsd.sum()), 'netUsdBaseline': float(data.netUsd.sum()),
            'conservativeNetUsdKept': float(kept.conservativeNetUsd.sum()),
            'winRateKept': float((kept.netUsd > 0).mean()) if len(kept) else None,
            'severeLossRecall': fraction((reject & severe).sum(), severe.sum()),
            'failedExitRecall': fraction((reject & failed).sum(), failed.sum()),
            'heavyLossRecall': fraction((reject & heavy).sum(), heavy.sum()),
            'lossDollarRecall': fraction(loss[reject].sum(), loss.sum()),
            'positivePositionsRejected': fraction((reject & positive).sum(), positive.sum())}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    data = load_data(args.input)
    split, split_summary = temporal_split(data)
    columns = [*CHAIN_FEATURES, 'isV4', 'quotePrincipalToPoolSize', 'poolSizeToMarketCap']
    x = data[columns].astype(float).replace([np.inf, -np.inf], np.nan)
    masks = {name: (split == name).to_numpy() for name in ['train', 'validation', 'test']}
    test = data.loc[masks['test']].copy()
    results: dict[str, Any] = {'versions': {'lightgbm': lgb.__version__, 'sklearn': sklearn.__version__, 'pandas': pd.__version__, 'numpy': np.__version__}, 'split': split_summary,
                             'features': columns, 'rows': len(data), 'models': {}}
    predictions = test[['token', 'entryFeatureKey', 'delayBlocks', 'policy', 'netUsd', 'conservativeNetUsd', 'failedExits', 'exitReason']].copy()
    for name, label in [('positive_pnl', data.netUsd > 0), ('loss_over_5pct', data.netUsd < -.1)]:
        y = label.to_numpy().astype(int)
        model = lgb.LGBMClassifier(objective='binary', n_estimators=1000, learning_rate=.03,
            num_leaves=15, max_depth=-1, min_child_samples=100, reg_lambda=5,
            colsample_bytree=.9, random_state=42, n_jobs=4, verbosity=-1,
            deterministic=True, force_col_wise=True)
        model.fit(x.loc[masks['train']], y[masks['train']],
            eval_X=x.loc[masks['validation']], eval_y=y[masks['validation']],
            eval_metric='binary_logloss', callbacks=[lgb.early_stopping(50, verbose=False)])
        validation_scores = model.predict_proba(x.loc[masks['validation']])[:, 1]
        scores = model.predict_proba(x.loc[masks['test']])[:, 1]
        thresholds = choose_thresholds(y[masks['validation']], validation_scores)
        importance = model.booster_.feature_importance(importance_type='gain')
        importance = [{'feature': column, 'gain': float(value), 'gainShare': float(value / importance.sum())}
                      for column, value in zip(columns, importance)]
        importance.sort(key=lambda row: row['gain'], reverse=True)
        operating = {}
        for target, threshold in thresholds.items():
            if threshold is None:
                operating[target] = None
                continue
            reject = scores < threshold if name == 'positive_pnl' else scores >= threshold
            operating[target] = {'validation': binary_metrics(y[masks['validation']], validation_scores, threshold),
                                 'test': binary_metrics(y[masks['test']], scores, threshold),
                                 'screening': portfolio(test, reject)}
        results['models'][name] = {'iterations': model.best_iteration_,
            'trainPrevalence': float(y[masks['train']].mean()), 'validationPrevalence': float(y[masks['validation']].mean()),
            'testPrevalence': float(y[masks['test']].mean()),
            'rocAuc': float(roc_auc_score(y[masks['test']], scores)),
            'averagePrecision': float(average_precision_score(y[masks['test']], scores)),
            'operatingPoints': operating, 'importance': importance}
        model.booster_.save_model(str(args.output / f'{name}.txt'))
        predictions[name] = scores
    results['combinedFilters'] = []
    for positive_target, loss_target in [('precision_80', 'precision_80'), ('precision_80', 'recall_90'), ('max_f1', 'precision_80')]:
        positive_point = results['models']['positive_pnl']['operatingPoints'][positive_target]
        loss_point = results['models']['loss_over_5pct']['operatingPoints'][loss_target]
        if positive_point is not None and loss_point is not None:
            reject = (predictions.positive_pnl.to_numpy() < positive_point['test']['threshold']) | (predictions.loss_over_5pct.to_numpy() >= loss_point['test']['threshold'])
            results['combinedFilters'].append({'positiveTarget': positive_target, 'lossTarget': loss_target, 'screening': portfolio(test, reject)})
    predictions.to_csv(args.output / 'test-predictions.csv', index=False)
    (args.output / 'summary.json').write_text(json.dumps(results, indent=2))
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.with_suffix('.json').write_text(json.dumps(results, indent=2))
    args.report.write_text(report(results))
    print(json.dumps({'split': split_summary, 'models': {name: {key: value for key, value in model.items() if key not in ['importance', 'operatingPoints']} for name, model in results['models'].items()}}))


def report(results: dict[str, Any]) -> str:
    pct = lambda value: f'{100 * value:.1f}%' if value is not None else '—'
    split = results['split']
    text = '# Arc chain-based screening: two LightGBM classifiers\n\n'
    text += 'Labels: positive net P&L (`netUsd > 0`) and loss greater than 5% of the $2 stake (`netUsd < -0.10`). Labels include all modeled costs. Only entered positions are trained; never-funded and failed-entry records are excluded. Main-case labels use the existing unknown-honeypot-clear assumption. Current security, addresses, exit outcomes and future observations are excluded from model inputs.\n\n'
    text += f"Only +4 blocks / 40% at 2.5x is evaluated, one row per token. Token-grouped chronological 60/20/20 split with a {split['purgeSeconds']}-second holding-horizon purge before validation/test. Rows: {split['rows']}; tokens: {split['tokens']}. Thresholds are selected using validation only; test data is untouched until evaluation. All model inputs are chain observations at entry.\n\n"
    text += 'Two modest LightGBM models (15 leaves, minimum 100 rows/leaf, learning rate 0.03, L2=5, up to 1,000 rounds with 50-round early stopping); no test-driven tuning or class reweighting.\n\n'
    text += '| Model | Test prevalence | Accuracy at 0.5 | ROC AUC | Average precision | Rounds |\n|---|---:|---:|---:|---:|---:|\n'
    for name, model in results['models'].items():
        text += f"| {name} | {pct(model['testPrevalence'])} | {pct(model['operatingPoints']['default']['test']['accuracy'])} | {model['rocAuc']:.3f} | {model['averagePrecision']:.3f} | {model['iterations']} |\n"
    text += '\n## Held-out operating points\n\nFor the positive model, keep predicted positives; for the loss model, reject predicted positives. Target names describe validation targets, not guaranteed test performance. Precision/recall refer to the model label. Loss dollars include all negative positions; heavy losses mean at least $1 lost.\n\n'
    text += '| Model / validation target | Threshold | Test precision | Test recall | Kept entries | Kept P&L / baseline | Kept P&L unknown-blocked | Failed exits caught | Heavy losses caught | Loss dollars caught | Winners rejected |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n'
    for name, model in results['models'].items():
        for target, point in model['operatingPoints'].items():
            if point is None:
                text += f'| {name} / {target} | unavailable on validation | | | | | | | | | |\n'
                continue
            metrics, screening = point['test'], point['screening']
            text += f"| {name} / {target} | {metrics['threshold']:.4f} | {pct(metrics['precision'])} | {pct(metrics['recall'])} | {screening['entriesKept']} | ${screening['netUsdKept']:.2f} / ${screening['netUsdBaseline']:.2f} | ${screening['conservativeNetUsdKept']:.2f} | {pct(screening['failedExitRecall'])} | {pct(screening['heavyLossRecall'])} | {pct(screening['lossDollarRecall'])} | {pct(screening['positivePositionsRejected'])} |\n"
    text += '\n## Feature importance\n\nNormalized LightGBM split gain; correlated fields can share or substitute importance, so these scores describe model use rather than causal effects.\n\n'
    for name, model in results['models'].items():
        text += f'### {name}\n\n| Feature | Gain | Gain share |\n|---|---:|---:|\n'
        for row in model['importance']:
            text += f"| {row['feature']} | {row['gain']:.2f} | {pct(row['gainShare'])} |\n"
    text += '\n## Combined model filters\n\nBoth validation-selected gates applied together.\n\n| Winner target / loss target | Kept entries | Kept P&L | Failed exits caught | Heavy losses caught | Loss dollars caught | Winners rejected |\n|---|---:|---:|---:|---:|---:|---:|\n'
    for row in results['combinedFilters']:
        screening = row['screening']
        text += f"| {row['positiveTarget']} / {row['lossTarget']} | {screening['entriesKept']} | ${screening['netUsdKept']:.2f} | {pct(screening['failedExitRecall'])} | {pct(screening['heavyLossRecall'])} | {pct(screening['lossDollarRecall'])} | {pct(screening['positivePositionsRejected'])} |\n"
    text += '\nExplicit five-feature screening rules are optimized separately with Optuna in optimize_rule.py.\n'
    text += '\nOutputs: two native LightGBM model files, test-predictions.csv, full summary JSON and this report. Rerun train_screening.py against results468 with the isolated ml-env Python. Feature definitions remain in features-README.md.\n'
    return text


if __name__ == '__main__':
    main()
