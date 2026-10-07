from pathlib import Path
import importlib.util
import unittest

SCRIPT = Path(__file__).parents[1] / "tools" / "measure_auto_edit_quality.py"
SPEC = importlib.util.spec_from_file_location("quality_measure", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)

class MeasurementTests(unittest.TestCase):
    def test_sampling_never_exceeds_120_frames(self):
        for duration in (1, 30, 120, 3600):
            rate = MODULE.whole_video_sample_fps(duration)
            self.assertLessEqual(rate * duration, MODULE.MAX_WHOLE_VIDEO_SAMPLES)
            self.assertLessEqual(rate, 2)

    def test_fixed_camera_is_not_a_duplicate_edit(self):
        same = bytes([100] * 256)
        self.assertEqual(MODULE.find_rendered_duplicates([same] * 12, 2, 6), [])

    def test_return_after_visibly_different_shot_is_duplicate(self):
        first = bytes([100] * 256)
        changed = bytes([220] * 256)
        result = MODULE.find_rendered_duplicates(
            [first, first, changed, changed, first, first], 2, 3
        )
        self.assertTrue(result)

if __name__ == "__main__":
    unittest.main()
