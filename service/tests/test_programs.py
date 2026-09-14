import copy
import importlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from programs import ProgramStore, compile_program

GRAPH = {'nodes': [{'id':'a','i':0,'j':0}, {'id':'b','i':1,'j':0}, {'id':'c','i':1,'j':1}],
         'edges':[{'from':'a','to':'b','length':2}, {'from':'b','to':'c','length':0.75}], 'meta':None}
PROGRAM = {'name':'Груз', 'start_node':'a', 'actions':[
    {'type':'move','target_node':'b'}, {'type':'lift','lift_action':'up'},
    {'type':'move','target_node':'c'}, {'type':'lift','lift_action':'down'}]}


class PlannerTests(unittest.TestCase):
    def test_turns_keep_heading_between_actions_and_use_edge_lengths(self):
        plan = compile_program(PROGRAM, GRAPH)
        self.assertEqual(plan['route'], ['a','b','c'])
        self.assertEqual(plan['distance_m'], 2.75)
        self.assertEqual([c['angle'] for c in plan['commands'] if c['type']=='turn'], [-90,90])
        self.assertEqual([c['distance'] for c in plan['commands'] if c['type']=='drive'], [2,0.75])
        self.assertEqual(PROGRAM['start_node'], 'a')

    def test_whole_program_rejected_for_unreachable_or_unknown_action(self):
        graph = copy.deepcopy(GRAPH); graph['edges'].pop()
        with self.assertRaises(ValueError): compile_program(PROGRAM, graph)
        program = copy.deepcopy(PROGRAM); program['actions'].append({'type':'unknown'})
        with self.assertRaises(ValueError): compile_program(program, GRAPH)

    def test_malformed_graphs(self):
        for bad in [-1, float('nan'), float('inf'), True, '2']:
            graph = copy.deepcopy(GRAPH); graph['edges'][0]['length'] = bad
            with self.subTest(bad=bad), self.assertRaises(ValueError): compile_program(PROGRAM, graph)
        graph = copy.deepcopy(GRAPH); graph['nodes'][1]['j'] = 1
        with self.assertRaises(ValueError): compile_program(PROGRAM, graph)

    def test_second_save_and_restart_and_corrupt_storage(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)/'programs.json'; store = ProgramStore(path)
            first = store.save(PROGRAM, GRAPH); second = store.save(PROGRAM, GRAPH)
            self.assertNotEqual(first['id'], second['id'])
            self.assertEqual(len(ProgramStore(path).read()), 2)
            path.write_text('{broken')
            with self.assertRaises(ValueError): store.save(PROGRAM, GRAPH)
            self.assertEqual(path.read_text(), '{broken')


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.env = patch.dict(os.environ, {'WDR_DATA_DIR':cls.temp.name})
        cls.env.start()
        cls.module = importlib.import_module('app')
        cls.app = cls.module.app
        cls.app.config['TESTING'] = True

    @classmethod
    def tearDownClass(cls):
        cls.env.stop(); cls.temp.cleanup()

    def setUp(self):
        self.client = self.app.test_client()
        self.store = self.app.extensions['program_store']
        self.store.path.unlink(missing_ok=True)
        self.app.extensions['program_runner'].run = None
        Path(self.module.GRAPH_PATH).write_text(json.dumps(GRAPH))
        self.hardware = patch('programs._robot_request', return_value=('OK', None))
        self.send = self.hardware.start()
        self.addCleanup(self.hardware.stop)

    def post(self, path, data): return self.client.post(path, json=data)

    def test_pages_and_assets(self):
        for url in ['/', '/new-task', '/robot-programmer', '/logo.png', '/drone-icon.png']:
            with self.client.get(url) as response:
                self.assertEqual(response.status_code, 200, url)

    def test_save_twice_reload_delete_and_missing(self):
        ids = []
        for _ in range(2):
            response = self.post('/api/robot/programs', PROGRAM)
            self.assertEqual(response.status_code, 201)
            ids.append(response.json['program']['id'])
        self.assertEqual(len(self.client.get('/api/robot/programs').json['programs']), 2)
        self.assertEqual(self.client.delete('/api/robot/programs/'+ids[0]).status_code, 200)
        self.assertEqual(self.client.delete('/api/robot/programs/'+ids[0]).status_code, 404)
        self.assertEqual(self.post('/api/robot/execute-program', {'program_id':ids[1]}).json['plan']['distance_m'], 2.75)
        self.send.assert_not_called()

    def test_preview_and_default_execution_do_not_contact_hardware(self):
        for url in ['/api/robot/programs/preview','/api/robot/execute-current-program']:
            response = self.post(url, PROGRAM)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json['plan']['route'], ['a','b','c'])
        self.send.assert_not_called()

    def test_bad_requests_and_map_save_preserves_previous_on_error(self):
        for data in [None, [], {'actions':[]}, {**PROGRAM,'actions':[{'type':'lift','lift_action':'oops'}]}]:
            self.assertEqual(self.post('/api/robot/programs', data).status_code, 400)
        self.assertEqual(self.post('/api/graph', {'nodes':[], 'edges':[{}]}).status_code, 400)
        self.assertEqual(json.loads(Path(self.module.GRAPH_PATH).read_text()), GRAPH)
        self.send.assert_not_called()

    def start(self):
        response = self.post('/api/robot/execute-current-program', {**PROGRAM,'dry_run':False})
        self.assertEqual(response.status_code, 200)
        return response.json['run']

    def test_live_steps_confirmation_duplicate_protection_and_completion(self):
        run = self.start(); self.send.assert_not_called()
        self.assertEqual(self.post('/api/robot/send', {'target_node_id':'b'}).status_code, 409)
        self.assertEqual(self.post('/api/robot/lift/up', {}).status_code, 409)
        step = {'run_id':run['id'],'expected_index':0,'confirm_completed':True}
        response = self.post('/api/robot/program-run/step', step)
        self.assertEqual(response.json['run']['status'], 'waiting')
        self.send.assert_called_once_with('192.168.4.1','/turn',{'angle':-90})
        self.assertEqual(self.post('/api/robot/program-run/step', step).status_code, 400)
        self.assertEqual(self.send.call_count, 1)
        step['expected_index'] = 1; step['confirm_completed'] = False
        self.assertEqual(self.post('/api/robot/program-run/step', step).status_code, 400)
        step['confirm_completed'] = True
        for index in range(1, len(run['plan']['commands']) + 1):
            step['expected_index'] = index
            response = self.post('/api/robot/program-run/step', step)
            self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json['run']['status'], 'completed')
        self.assertEqual(self.send.call_count, len(run['plan']['commands']))

    def test_error_blocks_retry_until_stop_and_stop_failure_keeps_lock(self):
        run = self.start(); self.send.return_value = (None,'timeout')
        step = {'run_id':run['id'],'expected_index':0,'confirm_completed':True}
        response = self.post('/api/robot/program-run/step', step)
        self.assertEqual(response.status_code, 502)
        self.assertEqual(self.post('/api/robot/program-run/step', step).status_code, 400)
        self.assertEqual(self.post('/api/robot/stop', {}).status_code, 502)
        self.assertEqual(self.post('/api/robot/send', {}).status_code, 409)
        self.send.return_value = ('OK',None)
        self.assertEqual(self.post('/api/robot/stop', {}).json['run']['status'], 'stopped')
        self.send.assert_called_with('192.168.4.1','/stop')

    def test_lift_uses_wdr_endpoints_and_saved_program_does_not_change(self):
        self.assertEqual(self.post('/api/robot/lift/up', {}).status_code, 200)
        self.send.assert_called_with('192.168.4.1','/lift_up')
        saved = self.post('/api/robot/programs', PROGRAM).json['program']
        before = self.store.path.read_bytes()
        response = self.post('/api/robot/execute-program', {'program_id': saved['id'], 'dry_run':False})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.store.path.read_bytes(), before)

    def test_topology_example(self):
        image = Path(__file__).resolve().parents[1]/'examples/warehouse.png'
        with image.open('rb') as stream:
            response = self.client.post('/api/analyze-topology', data={'image':(stream,'warehouse.png')})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json['walls']), 4)
        self.assertEqual(len(response.json['shelves']), 2)
        self.assertTrue(all(s[2] < response.json['walls'][2] / 2 for s in response.json['shelves']))


if __name__ == '__main__': unittest.main()
