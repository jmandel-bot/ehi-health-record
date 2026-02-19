BUN := bun

.PHONY: all setup load project test health-record clean

all: load project test health-record

setup:
	./setup.sh

load:
	$(BUN) run src/load_sqlite.ts

project:
	$(BUN) run src/project.ts --db ehi_clean.db --out patient_record.json

test:
	$(BUN) run test/test_project.ts --db ehi_clean.db
	$(BUN) run test/test_healthrecord.ts

health-record:
	$(BUN) run test/test_healthrecord.ts

clean:
	rm -f ehi_clean.db patient_record.json health_record_compact.json health_record_full.json
