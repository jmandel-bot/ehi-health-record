BUN := bun

.PHONY: all load project test health-record clean

all: load project test health-record

load:
	python3 load_sqlite.py

project:
	$(BUN) run project.ts --db ehi_clean.db --out patient_record.json

test:
	$(BUN) run test_project.ts --db ehi_clean.db

health-record:
	$(BUN) run test_healthrecord.ts

clean:
	rm -f ehi_clean.db patient_record.json health_record_compact.json health_record_full.json
