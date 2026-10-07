import importlib.util
from pathlib import Path
import unittest
from types import SimpleNamespace
import copy

spec = importlib.util.spec_from_file_location('synthesis', Path(__file__).parents[1] / 'scripts/synthesize-edit-narration.py')
synthesis = importlib.util.module_from_spec(spec)
spec.loader.exec_module(synthesis)
spec = importlib.util.spec_from_file_location('verification', Path(__file__).parents[1] / 'scripts/verify-edit-narration.py')
verification = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verification)

class DeliveryTests(unittest.TestCase):
    def test_retry_timeout_retains_other_lines_and_exposes_missing_reason(self):
        report={'lines':[{'file':'good.wav','text':'Good words'},{'file':'stale.wav','text':'Retry words'}]}
        verification.mark_retry_failure(report,[1],'TimeoutExpired')
        self.assertEqual(report['lines'][0]['file'],'good.wav')
        self.assertNotIn('file',report['lines'][1])
        self.assertIn('TimeoutExpired',report['lines'][1]['skipped'])

    def test_partial_delivery_is_valid_but_not_complete(self):
        lines=[{'start':0,'end':3,'text':'Hello there.'},{'start':4,'end':7,'text':'More words here.'}]
        request={'duration':8,'lines':lines}
        ready={'lines':[{**lines[1],'requestIndex':1,'seconds':2}]}
        self.assertEqual(verification.validate_ready_lines(request,ready),{'requested':2,'delivered':1,'complete':False})
        ready['lines'].append({**lines[0],'requestIndex':0,'seconds':2})
        self.assertTrue(verification.validate_ready_lines(request,ready)['complete'])
        self.assertFalse(verification.validate_ready_lines(request,{'lines':[]})['complete'])
        for field,value in [('text','Unapproved words'),('start',1),('seconds',float('nan')),('seconds',5),('requestIndex',1)]:
            bad=copy.deepcopy(ready);bad['lines'][1][field]=value
            with self.subTest(field=field,value=value),self.assertRaises(ValueError):verification.validate_ready_lines(request,bad)

    def test_captions_use_real_timing_and_reject_missing_or_reversed_clock(self):
        line={'start':1,'end':6,'seconds':4,'text':'Your music is playing.'}
        timed=[SimpleNamespace(word=word,start=i*.6,end=(i+1)*.6) for i,word in enumerate(line['text'].split())]
        captions=verification.captions_for_line(line,[SimpleNamespace(words=timed)])
        self.assertEqual(' '.join(c['text'] for c in captions),line['text'])
        self.assertEqual(captions[0]['start'],1)
        for bad in ([],timed[:-1],timed[::-1]):
            with self.assertRaises(ValueError):verification.captions_for_line(line,[SimpleNamespace(words=bad)])

    def test_standalone_voice_budget_does_not_relax_edit_windows(self):
        request={'duration':90,'lines':[{'start':0,'end':90,'text':'A continuous standalone recording.'}]}
        with self.assertRaises(ValueError):synthesis.normalize_delivery(request)
        self.assertEqual(synthesis.normalize_delivery({**request,'purpose':'standalone_voice'})['delivery'],'continuous')
        with self.assertRaises(ValueError):synthesis.normalize_delivery({**request,'purpose':'standalone_voice','lines':[{'start':0,'end':90,'text':'a'*501}]})
        with self.assertRaises(ValueError):synthesis.normalize_delivery({'duration':91,'purpose':'standalone_voice','lines':[{'start':0,'end':91,'text':'hello'}]})

    def test_language_aware_personal_clone_keeps_legacy_and_same_language_route(self):
        request={'purpose':'standalone_voice','emotion':'neutral','language':'es'}
        self.assertEqual(synthesis.reference_method(request,'reference words','en',True),'reference_cross_lingual')
        self.assertEqual(synthesis.reference_method(request,'reference words','es',True),'reference_zero_shot')
        self.assertEqual(synthesis.reference_method({'emotion':'neutral','language':'es'},'reference words','en',True),'reference_zero_shot')
        self.assertEqual(synthesis.reference_method({**request,'emotion':'excited'},'reference words','en',True),'directed_instruct2')
        self.assertEqual(synthesis.reference_method({'voiceReferenceKind':'personal','emotion':'neutral','language':'es'},'reference words','en',True),'reference_cross_lingual')

    def test_overlap_empty_and_whitespace_rejected_before_gpu(self):
        for lines in ([],[{'start':0,'end':4,'text':'  '}],[{'start':0,'end':4,'text':'hello'},{'start':3,'end':6,'text':'world'}]):
            with self.assertRaises(ValueError):synthesis.normalize_delivery({'duration':8,'lines':lines})

    def test_contractions_preserve_meaning_and_caption_character_clock(self):
        a="Phone running low while your music's playing? It's convenient. There's an offer."
        b="Phone running low while your music is playing. It is convenient. There is an offer."
        self.assertEqual(verification.words(a), verification.words(b))
        self.assertNotEqual(verification.words("It is not charging"),verification.words("It is charging"))
        self.assertNotEqual(verification.words("John's phone"),verification.words("John is phone"))
        tokens=a.split()
        lengths=[verification.contextual_character_count(t,tokens[i+1] if i+1<len(tokens) else '') for i,t in enumerate(tokens)]
        self.assertEqual(sum(lengths),len(''.join(verification.words(a))))

    def test_exact_brand_letter_separation_is_not_a_brand_failure(self):
        request={'lines':[{'text':'The STOREONE speaker keeps the music going.'}]}
        brands=verification.approved_brand_tokens(request)
        approved=verification.words(request['lines'][0]['text'],approved_brands=brands)
        self.assertEqual(verification.words('The OMU-CA speaker keeps the music going.',approved_brands=brands),approved)
        self.assertEqual(verification.words('The O M U C A speaker keeps the music going.',approved_brands=brands),approved)
        self.assertNotEqual(verification.words('The OMU Music speaker keeps the music going.',approved_brands=brands),approved)
        self.assertNotEqual(verification.words('The OMUKA speaker keeps the music going.',approved_brands=brands),approved)

    def test_old_auto_request_accepts_long_continuous_line(self):
        request = {'duration': 22.3, 'lines': [{'start': .2, 'end': 21.9, 'text': 'x' * 370}]}
        self.assertEqual(synthesis.normalize_delivery(request)['delivery'], 'continuous')

    def test_invalid_windows_rejected_before_loading_model(self):
        for start, end in [(0, 31), (-1, 4), (0, float('nan')), (0, 50)]:
            with self.assertRaises(ValueError):
                synthesis.normalize_delivery({'duration': 30, 'lines': [{'start': start, 'end': end, 'text': 'hello'}]})

if __name__ == '__main__':
    unittest.main()
