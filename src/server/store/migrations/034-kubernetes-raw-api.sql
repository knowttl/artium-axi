UPDATE tools SET raw_api_mode = 'read' WHERE name = 'kubernetes-axi';
UPDATE role_tools SET raw_api = 1 WHERE tool = 'kubernetes-axi';
