"""Behavior boundaries for the explicit entry screening rule."""
from pathlib import Path
import sys
import unittest

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parents[1] / 'scripts/arc-backtest'))
from optimize_rule import apply_rule


class ExplicitRuleTests(unittest.TestCase):
    def setUp(self):
        self.rule = {'usdcMin': 2, 'usdcShareMin': .01, 'usdcShareMax': .5,
                     'holderMax': .2, 'feeMaxPips': 10000, 'marketCapMin': 100,
                     'marketCapMax': 10000, 'allowMissingHolder': False, 'allowMissingFee': False}

    def test_printed_half_pool_boundary_ignores_machine_epsilon_without_mutating_features(self):
        frame = pd.DataFrame({'poolQuotePrincipalUsd': [300, 1.99],
                              'quotePrincipalToPoolSize': [.5000000000000001, .5],
                              'top1HolderShare': [.05, .05], 'observedPoolFeePips': [3000, 3000],
                              'marketCapUsd': [5000, 5000]})
        before = frame.copy(deep=True)
        np.testing.assert_array_equal(apply_rule(frame, self.rule), [True, False])
        pd.testing.assert_frame_equal(frame, before)

    def test_missing_value_permission_only_applies_to_its_own_condition(self):
        frame = pd.DataFrame({'poolQuotePrincipalUsd': [300, 300],
                              'quotePrincipalToPoolSize': [.3, .3], 'top1HolderShare': [None, None],
                              'observedPoolFeePips': [None, None], 'marketCapUsd': [5000, 10001]})
        np.testing.assert_array_equal(apply_rule(frame, self.rule), [False, False])
        permissive = {**self.rule, 'allowMissingHolder': True, 'allowMissingFee': True}
        np.testing.assert_array_equal(apply_rule(frame, permissive), [True, False])


if __name__ == '__main__':
    unittest.main()
