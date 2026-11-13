import unittest
from easyread.reflow_prepare import mapping

def node(value,page=0,kind='paragraph'):
    return {'type':kind,'content':[{'text':value}],'anchor':{'pageRects':[[page,0,0,100,10]]}}

def block(value,id='p1-1',kind='para'):
    return {'id':id,'type':kind,'page':1,'en':value,'zh':'已有中文'}

class MappingTest(unittest.TestCase):
    def map(self,blocks,nodes):return mapping({'blocks':blocks},{'content':nodes},'f'*64)
    def test_unique_split_ignores_intervening_footnote_but_preserves_order(self):
        b=block('Setting $x$: select data. Then train $y$ on it.')
        r=self.map([b],[node('Setting x: select data.'),node('unrelated footnote'),node('Then train y on it.')])
        self.assertEqual(r['records'][0]['refs'],[[0],[2]])
        self.assertEqual(r['records'][0]['source_chinese'],'已有中文')
    def test_duplicate_content_remains_unresolved(self):
        r=self.map([block('Same phrase')],[node('Same phrase'),node('Same phrase')])
        self.assertEqual(r['counts'],{'mapped':0,'unresolved':1})
    def test_missing_words_are_not_fuzzy_adopted(self):
        r=self.map([block('The model does not improve quality')],[node('The model does improve quality')])
        self.assertEqual(r['counts']['unresolved'],1)
    def test_list_labels_are_not_content_changes(self):
        b={'id':'list','type':'list','page':1,'items':[{'en':'First item','zh':'第一项'},{'en':'Second item','zh':'第二项'}]}
        n={'type':'list','anchor':{'pageRects':[[0,0,0,100,100]]},'content':[node('1. First item',kind='listitem'),node('2. Second item',kind='listitem')]}
        self.assertEqual(self.map([b],[n])['counts']['mapped'],1)
    def test_caption_does_not_require_translated_table_resource(self):
        b=block('Table 1: Scores',kind='table');b['caption_en']=b.pop('en');b['caption_zh']=b.pop('zh')
        r=self.map([b],[node('Table 1: Scores')]);self.assertEqual(r['counts']['mapped'],1)
        self.assertEqual(r['records'][0]['content_scope'],'caption')
        self.assertTrue(r['records'][0]['visual_review_required'])
        self.assertNotIn('resource_refs',r['records'][0])

    def test_long_plain_prose_can_split_between_nodes(self):
        first='This first sentence establishes the evidence and explains how a long paragraph can continue across a page. '
        second='The final sentence must also be present before the correspondence is accepted.'
        r=self.map([block(first+second)],[node(first),node(second)])
        self.assertEqual(r['records'][0]['refs'],[[0],[1]])

    def test_matching_table_is_not_confused_with_next_table(self):
        b=block('Table 2: Results',kind='table');b['caption_en']=b.pop('en');b['caption_zh']=b.pop('zh')
        r=self.map([b],[node('Table 2: Results',kind='table'),node('Table 3: Scores',kind='caption'),node('Other results',kind='table')])
        self.assertEqual(r['records'][0]['resource_refs'],[[0]])

    def test_short_role_marker_can_start_a_long_source_unit(self):
        r=self.map([block('<|user|> Question here <|assistant|> Answer here')],[node('<|user|>'),node('Question here'),node('<|assistant|>'),node('Answer here')])
        self.assertEqual(r['records'][0]['refs'],[[0],[1],[2],[3]])

    def test_excluded_source_is_restored_only_on_exact_correspondence(self):
        n=node('11https://example.org/source-evidence');n['flowClass']='excluded'
        r=self.map([block('$^{11}$https://example.org/source-evidence')],[n])
        self.assertTrue(r['records'][0]['restore_excluded_source'])

    def test_figure_reference_number_is_content(self):
        from easyread.reflow_prepare import matching_text
        caption=node('Figure 5: Original evidence',kind='caption');caption['flowClass']='auxiliary'
        paragraph={'content':[{'text':'Figure '},{'text':'5','refs':[[1]]},{'text':' supports the result'}]}
        self.assertEqual(matching_text(paragraph,{'content':[paragraph,caption]}),'Figure 5 supports the result')

if __name__=='__main__':unittest.main()
