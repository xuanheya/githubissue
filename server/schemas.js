import Ajv from "ajv";

const ajv = new Ajv({ allErrors: false });
const str = (maxLength = 600) => ({ type: "string", minLength: 1, maxLength, pattern: "\\S" });
const list = (items, maxItems, minItems = 0) => ({ type: "array", items, minItems, maxItems });
const obj = properties => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const refs = { ...list(str(12), 8, 1), uniqueItems: true };
export const analysisSchema = obj({
  summary: str(260),
  hypotheses: list(obj({ claim: str(), evidenceIds: refs, howToCheck: str() }), 4),
  steps: list(obj({ action: str(), expectedObservation: str(), evidenceIds: refs }), 6, 1),
  clarifications: list(obj({ question: str(), whyItMatters: str() }), 5),
  changes: list(obj({ description: str(), evidenceIds: refs }), 6),
  limitations: list(str(), 5)
});

export const definitions = {
  search_repo: {
    description: "按当前仓库的路径或文件名关键词寻找文件。多个词按匹配数排序。返回 fileId，未检索文件正文。",
    parameters: obj({ terms: list(str(80), 5, 1), purpose: str(180) })
  },
  read_excerpt: {
    description: "读取已返回的 fileId，在文件内按字面量 anchor 找片段。空 anchor 从文件头读。返回行号和证据 ID。",
    parameters: obj({ fileId: str(12), anchor: { type: "string", maxLength: 160 }, purpose: str(180) })
  },
  submit_analysis: {
    description: "提交本轮中文建议。引用已经取得的 I/C/R 证据 ID。首次 changes 为空，重规划须引用新背景说明影响。",
    parameters: analysisSchema
  }
};

export const toolSpecs = Object.entries(definitions).map(([name, definition]) =>
  ({ type: "function", function: { name, ...definition } }));
const validators = new Map(Object.entries(definitions).map(([name, definition]) =>
  [name, ajv.compile(definition.parameters)]));
export function validateTool(name, args) {
  const validate = validators.get(name);
  if (!validate) return "未知工具";
  return validate(args) ? null : ajv.errorsText(validate.errors).slice(0, 240);
}

export function validateAnalysis(result, knownIds, newContextId) {
  const shapeError = validateTool("submit_analysis", result);
  if (shapeError) return shapeError;
  for (const item of [...result.hypotheses, ...result.steps, ...result.changes]) {
    if (item.evidenceIds.some(id => !knownIds.has(id))) return "引用的证据 ID 不存在";
  }
  if (!newContextId && result.changes.length) return "首次分析的 changes 应为空";
  if (newContextId && !result.changes.some(change => change.evidenceIds.includes(newContextId))) {
    return "changes 必须引用本次新增背景并说明其影响";
  }
  return null;
}
