import sqlite3
import json

db = sqlite3.connect(r'C:\SeasunGame\Game\JX3\bin\zhcn_hd\interface\JX\JX_Buff\data\buff_info.db')
cursor = db.cursor()

cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
tables = cursor.fetchall()
print('Tables:', [t[0] for t in tables])

for t in tables:
    tn = t[0]
    print(f'\n=== {tn} ===')
    cursor.execute(f'PRAGMA table_info("{tn}")')
    cols = cursor.fetchall()
    print('Columns:', [(c[1], c[2]) for c in cols])
    cursor.execute(f'SELECT * FROM "{tn}" LIMIT 5')
    rows = cursor.fetchall()
    for r in rows:
        print('  ', r)
    cursor.execute(f'SELECT COUNT(*) FROM "{tn}"')
    count = cursor.fetchone()[0]
    print(f'  Total rows: {count}')

db.close()
