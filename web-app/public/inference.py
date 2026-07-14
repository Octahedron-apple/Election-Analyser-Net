import pandas as pd
import numpy as np
import pickle
import json
import pyodide.http
import io
import traceback
import asyncio

# ── Strategy tips lookup ──────────────────────────────────────────────────────
AGE_TIPS = {
    "18-19":      "Run social media campaigns (Instagram/YouTube); focus on education & first jobs.",
    "20-29":      "Prioritise employment, startup support, and digital schemes.",
    "30-39":      "Focus on housing, job security, and children's education.",
    "40-49":      "Highlight economic stability, MSP for farmers, health insurance.",
    "50-59":      "Push pension security, healthcare, and agricultural loan waivers.",
    "60-69":      "Promote senior welfare, pension hike, free medical camps.",
    "70 & Above": "Focus on elder care, pension reliability, and pilgrimage schemes.",
}
EDU_TIPS = {
    "Not Gone to School":    "Hold community meetings; use local language and visuals.",
    "Upto 9th":              "Use pamphlets and radio; keep messages simple.",
    "10th Pass":             "Highlight skill development (ITI/polytechnic) and job schemes.",
    "12th Pass":             "Push government job opportunities and coaching support.",
    "Graduate":              "Focus on white-collar employment and digital services.",
    "Post-Graduate":         "Highlight research funding and governance reforms.",
    "Professional Education":"Engage via policy papers, industry events, and tax relief.",
}
OCC_TIPS = {
    "Farmer":              "Announce MSP hike, irrigation schemes, crop insurance.",
    "Labour":              "Promise minimum wage increase and MNREGA expansion.",
    "Student":             "Offer free coaching, exam fee waivers, scholarships.",
    "Housewife":           "Highlight women SHG support, gas subsidy, cash-transfer schemes.",
    "Skilled Professional": "Promise easier business licenses and GST simplification.",
    "Unemployed":          "Announce employment guarantee and skill training programs.",
    "Government Employee": "Focus on pay-commission benefits and job security.",
    "Business":            "Highlight lower taxes and ease-of-doing-business policies.",
}

_model_cache = {}
_bihar_df = None

async def load_model(filename):
    if filename in _model_cache:
        return _model_cache[filename]
    resp = await pyodide.http.pyfetch(f"models/{filename}")
    if resp.status != 200:
        return None
    content = await resp.bytes()
    model = pickle.loads(content)
    _model_cache[filename] = model
    return model

async def get_bihar_data():
    global _bihar_df
    if _bihar_df is None:
        resp = await pyodide.http.pyfetch("models/bihar_election_dataset.csv")
        if resp.status == 200:
            content = await resp.bytes()
            _bihar_df = pd.read_csv(io.BytesIO(content))
    return _bihar_df

async def get_suggestion_for_voter(party_name, voter_profile):
    df = await get_bihar_data()
    if df is None:
        return []

    SEGMENT_MAP = {
        "Caste":      voter_profile.get("Caste"),
        "Age_Group":  voter_profile.get("Age_Group"),
        "Gender":     voter_profile.get("Gender"),
        "Geography":  voter_profile.get("Geography"),
        "Education":  voter_profile.get("Education"),
        "Occupation": voter_profile.get("Occupation"),
    }

    suggestions = []
    for col, val in SEGMENT_MAP.items():
        if not val: continue
        seg = df[df[col] == val]
        if len(seg) < 20:
            continue

        party_pct = (seg["Voted_Party"] == party_name).mean() * 100
        total     = len(seg)

        rival_counts = seg[seg["Voted_Party"] != party_name]["Voted_Party"].value_counts()
        if rival_counts.empty:
            continue
        rival      = rival_counts.idxmax()
        rival_pct  = (seg["Voted_Party"] == rival).mean() * 100
        gap        = round(rival_pct - party_pct, 1)

        if col == "Caste":
            tip = (f"Among {val} voters, {party_name} gets {party_pct:.0f}% vs "
                   f"{rival}'s {rival_pct:.0f}%. Field candidates from the {val} community, "
                   f"launch targeted welfare schemes, and engage local {val} leaders.")
        elif col == "Age_Group":
            base = AGE_TIPS.get(val, "Tailor outreach to this age group.")
            tip  = f"Among {val} voters, {party_name} gets {party_pct:.0f}% vs {rival}'s {rival_pct:.0f}%. {base}"
        elif col == "Gender":
            base = ("Launch women-centric welfare schemes (cash transfers, SHGs, safety)."
                    if val == "Female"
                    else "Address male voter concerns around employment and security.")
            tip  = f"Among {val} voters, {party_name} gets {party_pct:.0f}% vs {rival}'s {rival_pct:.0f}%. {base}"
        elif col == "Geography":
            tip  = (f"In {val} areas, {party_name} gets {party_pct:.0f}% vs {rival}'s {rival_pct:.0f}%. "
                    f"Increase candidate visits, local infrastructure promises, and booth-level outreach.")
        elif col == "Education":
            base = EDU_TIPS.get(val, "Tailor messaging to this education level.")
            tip  = f"Among {val}-educated voters, {party_name} gets {party_pct:.0f}% vs {rival}'s {rival_pct:.0f}%. {base}"
        elif col == "Occupation":
            base = OCC_TIPS.get(val, "Address key concerns of this group.")
            tip  = f"Among {val} voters, {party_name} gets {party_pct:.0f}% vs {rival}'s {rival_pct:.0f}%. {base}"
        else:
            tip = f"{party_name} should focus more on {val} voters."

        suggestions.append({
            "dimension":   col,
            "value":       val,
            "party_pct":   round(party_pct, 1),
            "rival":       rival,
            "rival_pct":   round(rival_pct, 1),
            "gap":         gap,
            "total":       total,
            "tip":         tip,
            "winning":     bool(party_pct >= rival_pct),
        })

    suggestions.sort(key=lambda x: x["gap"], reverse=True)
    return suggestions

async def bihar_voter_predict(data):
    model = await load_model("bihar_voter_prediction.pkl")
    if model is None:
        return {"status": "error", "detail": "Bihar model not found"}
    try:
        input_dict = {
            "Age_Group": data.get("Age_Group", "").strip(),
            "Gender": data.get("Gender", "").strip(),
            "Geography": data.get("Geography", "").strip(),
            "Education": (data.get("Education", "").strip() if data.get("Education") else ""),
            "Occupation": data.get("Occupation", "").strip(),
            "Caste": data.get("Caste", "").strip()
        }
        columns = ["Age_Group", "Gender", "Geography", "Education", "Occupation", "Caste"]
        features = pd.DataFrame([input_dict])[columns]
        prediction = model.predict(features)[0]
        
        proba = None
        estimator = model
        if hasattr(model, "steps"): 
            estimator = model.steps[-1][1]
        if hasattr(estimator, "predict_proba"):
            proba_vals = model.predict_proba(features)[0]
            classes = estimator.classes_
            proba = {str(c): round(float(p) * 100, 1) for c, p in zip(classes, proba_vals)}
        
        suggestions = await get_suggestion_for_voter(str(prediction), input_dict)

        return {
            "status": "success",
            "predicted_party": str(prediction),
            "probabilities": proba,
            "suggestions": suggestions
        }
    except Exception as e:
        return {"status": "error", "detail": str(e), "traceback": traceback.format_exc()}

async def maha_voter_predict(data):
    model = await load_model("maharashtra_voter_prediction.pkl")
    if model is None:
        return {"status": "error", "detail": "Maharashtra model not found"}
    try:
        input_dict = {
            "age": data.get("Age"),
            "gender": data.get("Gender", "").strip(),
            "district": data.get("District", "").strip(),
            "geography": data.get("Geography", "").strip(),
            "caste": data.get("Caste", "").strip(),
            "occupation": data.get("Occupation", "").strip()
        }
        if input_dict["caste"] == "OBC":
            input_dict["caste"] = "Other OBC"
        elif input_dict["caste"] == "General":
            input_dict["caste"] = "Other General"
        
        columns = ["age", "gender", "district", "geography", "caste", "occupation"]
        features = pd.DataFrame([input_dict])[columns]
        prediction = model.predict(features)[0]
        
        proba = None
        estimator = model
        if hasattr(model, "steps"): 
            estimator = model.steps[-1][1]
        if hasattr(estimator, "predict_proba"):
            proba_vals = model.predict_proba(features)[0]
            classes = estimator.classes_
            proba = {str(c): round(float(p) * 100, 1) for c, p in zip(classes, proba_vals)}
        return {
            "status": "success",
            "predicted_party": str(prediction),
            "probabilities": proba
        }
    except Exception as e:
        return {"status": "error", "detail": str(e), "traceback": traceback.format_exc()}

async def main():
    try:
        data = json.loads(INPUT_DATA)
        state = data.get("state", "bihar").lower()
        if state == "maharashtra":
            res = await maha_voter_predict(data)
        else:
            res = await bihar_voter_predict(data)
        return json.dumps(res)
    except Exception as e:
        return json.dumps({"status": "error", "detail": str(e), "traceback": traceback.format_exc()})

main()
