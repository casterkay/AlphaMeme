"""Regression tests for screening evaluation semantics, independent of training quality."""
import importlib.util
from pathlib import Path
import unittest

import numpy as np
import pandas as pd

spec = importlib.util.spec_from_file_location('screening', Path(__file__).parents[1] / 'scripts/arc-backtest/train_screening.py')
screening = importlib.util.module_from_spec(spec)
spec.loader.exec_module(screening)


class ScreeningEvaluationTests(unittest.TestCase):
    def test_time_split_keeps_tokens_together_and_purges_holding_horizon(self):
        frame = pd.DataFrame([{'token': str(index), 'entryTimestamp': index * 600 + delay}
                              for index in range(30) for delay in [0, 2]])
        split, summary = screening.temporal_split(frame)
        self.assertTrue((pd.DataFrame({'token': frame.token, 'split': split}).groupby('token').split.nunique() == 1).all())
        self.assertTrue((frame.loc[split == 'train', 'entryTimestamp'] + 1201 < summary['validationStart']).all())
        self.assertTrue((frame.loc[split == 'validation', 'entryTimestamp'] + 1201 < summary['testStart']).all())
        self.assertGreater(summary['rows']['purged'], 0)

    def test_failed_exit_after_partial_profit_is_not_necessarily_over_five_percent_loss(self):
        frame = pd.DataFrame({'netUsd': [-2, -.2, -.02, 1], 'conservativeNetUsd': [-2, -.2, -.02, 1], 'failedExits': [1, 0, 1, 0]})
        metrics = screening.portfolio(frame, np.array([False, False, True, False]))
        self.assertEqual(metrics['failedExitRecall'], .5)
        self.assertEqual(metrics['severeLossRecall'], 0)
        self.assertEqual(metrics['heavyLossRecall'], 0)
        self.assertEqual(metrics['positivePositionsRejected'], 0)

    def test_missing_feature_does_not_match_zero_threshold_and_unattainable_precision_stays_missing(self):
        frame = pd.DataFrame({'depth': [None, 0, 1]})
        np.testing.assert_array_equal(screening.rule_mask(frame, 'depth', '<=', 0), [False, True, False])
        thresholds = screening.choose_thresholds(np.tile([0, 1], 20), np.full(40, .5))
        self.assertIsNone(thresholds['precision_80'])
        self.assertIsNone(thresholds['precision_90'])


if __name__ == '__main__':
    unittest.main()
