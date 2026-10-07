import importlib.util
from pathlib import Path
import unittest
from types import SimpleNamespace
spec=importlib.util.spec_from_file_location('narration_verify',Path(__file__).resolve().parents[1]/'scripts/verify-edit-narration.py')
v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
class NarrationTextTests(unittest.TestCase):
 def test_spoken_equivalent_spelling_not_an_omission(self):
  self.assertEqual(v.words('Two rear grilles are visible.'),v.words('Two rear grills are visible.'))
  self.assertNotEqual(v.words('Two rear grilles are visible.'),v.words('Three rear grills are visible.'))
  self.assertNotEqual(v.words('Two rear grilles are visible.'),v.words('Two rear grills are not visible.'))
  self.assertNotEqual(v.words('12 3'),v.words('1 23'))
 def test_grouping_preserves_approved_words(self):
  text='Lower light keeps the changing side colors easy to follow.'
  self.assertEqual(' '.join(' '.join(g) for g in v.phrase_groups(text)),text)
 def test_readability_tail_cannot_overlay_next_phrase(self):
  captions=[{'start':0,'end':2.08},{'start':2,'end':3.08}]
  self.assertEqual(v.prevent_caption_overlap(captions)[0]['end'],2)
 def test_second_segmentation_cannot_force_changed_words_to_match(self):
  class Model:
   def __init__(self,second):self.calls=[];self.second=second
   def transcribe(self,file,**kwargs):
    self.calls.append(kwargs)
    return iter([SimpleNamespace(text='And lower light' if kwargs['vad_filter'] else self.second)]),None
  model=Model('In lower light')
  self.assertTrue(v.recognize_line(model,Path('fixture.wav'),'en','In lower light')[2])
  self.assertEqual([call['vad_filter'] for call in model.calls],[True,False])
  self.assertTrue(all('initial_prompt' not in call for call in model.calls))
  self.assertFalse(v.recognize_line(Model('And lower light'),Path('fixture.wav'),'en','In lower light')[2])
if __name__=='__main__':unittest.main()
