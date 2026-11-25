from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

Text = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=650)]
Pattern = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=160)]
Refs = Annotated[
    list[Annotated[str, Field(pattern=r"^[ICR][1-9][0-9]*$")]], Field(min_length=1, max_length=10)
]
Hid = Annotated[str, Field(pattern=r"^H[1-9][0-9]{0,2}$")]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class Glob(Strict):
    pattern: Pattern


class Grep(Strict):
    text: Pattern
    path_glob: Pattern


class ReadFile(Strict):
    file_id: Annotated[str, Field(pattern=r"^F[1-9][0-9]*$")]
    start_line: Annotated[int, Field(ge=1)]
    end_line: Annotated[int, Field(ge=1)]


class Hypothesis(Strict):
    id: Hid
    claim: Text
    evidenceIds: Refs
    counterEvidenceIds: list[str] = Field(max_length=8)
    howToCheck: Text


class Step(Strict):
    action: Text
    expectedObservation: Text
    evidenceIds: Refs


class Question(Strict):
    question: Text
    whyItMatters: Text


class Change(Strict):
    description: Text
    evidenceIds: Refs


class Report(Strict):
    summary: Text
    hypotheses: list[Hypothesis] = Field(max_length=4)
    steps: list[Step] = Field(min_length=1, max_length=6)
    clarifications: list[Question] = Field(max_length=5)
    changes: list[Change] = Field(max_length=5)
    limitations: list[Text] = Field(max_length=5)


TOOLS = {
    "glob": (Glob, "列出匹配路径及 fileId。相对根目录；** 可跨目录。返回路径并不代表看过实现。"),
    "grep": (
        Grep,
        "按字面量在 path_glob 范围内搜索正文。每次扫描最多 16 个候选文件，命中给出行号和 fileId。",
    ),
    "read_file": (ReadFile, "读取已定位的 file_id 和行号区间，返回能引用的 R 证据编号。"),
    "submit_analysis": (Report, "单独调用以提交中文报告。假设按优先级排序；更新说明须引用本次 C 编号。"),
}


def tool_specs(names):
    return [
        {
            "type": "function",
            "function": {
                "name": name,
                "description": TOOLS[name][1],
                "parameters": TOOLS[name][0].model_json_schema(),
            },
        }
        for name in names
    ]
