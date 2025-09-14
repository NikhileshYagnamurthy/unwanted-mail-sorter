import pandas as pd
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
import pickle

# 1. Load labeled CSV
df = pd.read_csv("emails.csv")

# 2. Drop rows with missing values
df = df.dropna()

if df.empty:
    print("❌ No labeled data found in emails.csv")
    exit()

# 3. Train model
vectorizer = TfidfVectorizer()
X = vectorizer.fit_transform(df["subject"])
y = df["label"]

model = LogisticRegression(max_iter=200)
model.fit(X, y)

# 4. Save model + vectorizer
with open("vectorizer.pkl", "wb") as f:
    pickle.dump(vectorizer, f)

with open("model.pkl", "wb") as f:
    pickle.dump(model, f)

print("✅ Model trained and saved as vectorizer.pkl & model.pkl")
