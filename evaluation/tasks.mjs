// Synthetic regression fixtures, not empirical engineering-quality evidence.
const pick = (condition, yes, no) => ({ condition, yes, no });
const operations = [
  {
    name: "addition",
    objective: "Return the sum of the two arguments.",
    broken: "x - y",
    correct: "x + y",
    expected: (x, y) => x + y,
  },
  {
    name: "subtraction",
    objective: "Subtract the second argument from the first.",
    broken: "x + y",
    correct: "x - y",
    expected: (x, y) => x - y,
  },
  {
    name: "multiplication",
    objective: "Return the product of the two arguments.",
    broken: "x + y",
    correct: "x * y",
    expected: (x, y) => x * y,
  },
  {
    name: "maximum",
    objective: "Return the larger argument, preserving equal values.",
    broken: pick("x < y", "x", "y"),
    correct: pick("x > y", "x", "y"),
    expected: Math.max,
  },
  {
    name: "minimum",
    objective: "Return the smaller argument, preserving equal values.",
    broken: pick("x > y", "x", "y"),
    correct: pick("x < y", "x", "y"),
    expected: Math.min,
  },
  {
    name: "absolute",
    objective: "Return the absolute value of x; y is unused.",
    broken: "x",
    correct: pick("x < 0", "-x", "x"),
    expected: (x) => Math.abs(x),
  },
  {
    name: "increment",
    objective: "Increment x by one; y is unused.",
    broken: "x - 1",
    correct: "x + 1",
    expected: (x) => x + 1,
  },
  {
    name: "nonnegative",
    objective:
      "Clamp negative x to zero and preserve nonnegative x; y is unused.",
    broken: "x",
    correct: pick("x < 0", "0", "x"),
    expected: (x) => Math.max(0, x),
  },
  {
    name: "even",
    objective:
      "Return one when x is even, otherwise zero, including negative x; y is unused.",
    broken: pick("x % 2 != 0", "1", "0"),
    correct: pick("x % 2 == 0", "1", "0"),
    expected: (x) => (x % 2 === 0 ? 1 : 0),
  },
  {
    name: "sign",
    objective:
      "Return negative one, zero, or one according to the sign of x; y is unused.",
    broken: pick("x > 0", "1", "-1"),
    correct: pick("x > 0", "1", pick("x < 0", "-1", "0")),
    expected: (x) => Math.sign(x),
  },
];
const inputs = [
  [-3, 7],
  [0, 0],
  [5, -2],
  [-6, -4],
  [2, 2],
  [1, 9],
  [4, 3],
  [0, -5],
];
const languages = ["javascript", "python", "go", "rust", "java", "csharp"];

function expression(tree, language) {
  if (typeof tree === "string") return tree;
  const yes = expression(tree.yes, language),
    no = expression(tree.no, language);
  if (language === "python") return `(${yes} if ${tree.condition} else ${no})`;
  if (language === "rust")
    return `(if ${tree.condition} { ${yes} } else { ${no} })`;
  return `(${tree.condition} ? ${yes} : ${no})`;
}
function goStatement(tree) {
  return typeof tree === "string"
    ? `return ${tree}`
    : `if ${tree.condition} { ${goStatement(tree.yes)} }; ${goStatement(tree.no)}`;
}
function source(language, tree) {
  const value = expression(tree, language);
  if (language === "javascript")
    return `export function evaluate(x, y) { return ${value}; }\n`;
  if (language === "python")
    return `def evaluate(x: int, y: int) -> int:\n    return ${value}\n`;
  if (language === "go")
    return `package main\nfunc Evaluate(x, y int) int { ${goStatement(tree)} }\n`;
  if (language === "rust")
    return `pub fn evaluate(x: i64, y: i64) -> i64 { ${value} }\n`;
  if (language === "java")
    return `public class Solution { public static long evaluate(long x, long y) { return ${value}; } }\n`;
  return `public static class Solution { public static long Evaluate(long x, long y) { return ${value}; } }\n`;
}
function verification(language, tests, marker) {
  if (language === "javascript")
    return {
      image: "node:24-slim",
      argv: ["node", "/checks/check.mjs"],
      files: {
        "check.mjs": `import { evaluate } from '/workspace/solution.mjs';\nfor (const [x,y,expected] of ${JSON.stringify(tests)}) { if (evaluate(x,y)!==expected) throw Error('Acceptance failed'); }\nconsole.log(${JSON.stringify(marker)});\n`,
      },
    };
  if (language === "python")
    return {
      image: "python:3.12-slim",
      argv: ["python", "/checks/check.py"],
      files: {
        "check.py": `import sys\nsys.path.insert(0, '/workspace')\nfrom solution import evaluate\nfor x,y,expected in ${JSON.stringify(tests)}:\n    if evaluate(x,y) != expected: raise AssertionError('Acceptance failed')\nprint(${JSON.stringify(marker)})\n`,
      },
    };
  if (language === "go")
    return {
      image: "golang:1.24",
      argv: [
        "sh",
        "-c",
        "cp /workspace/solution.go /checks/check.go /tmp/; cd /tmp; GOTOOLCHAIN=local GO111MODULE=off go run solution.go check.go",
      ],
      files: {
        "check.go": `package main\nimport "fmt"\nfunc main() { for _, test := range [][3]int{${tests.map((test) => `{${test.join(",")}}`).join(",")}} { if Evaluate(test[0],test[1]) != test[2] { panic("Acceptance failed") } }; fmt.Println(${JSON.stringify(marker)}) }\n`,
      },
    };
  if (language === "rust")
    return {
      image: "rust:1.85",
      argv: ["sh", "-c", "rustc /checks/check.rs -o /tmp/check && /tmp/check"],
      files: {
        "check.rs": `#[path="/workspace/solution.rs"] mod solution;\nfn main() { for [x,y,expected] in ${JSON.stringify(tests)} { assert_eq!(solution::evaluate(x,y),expected); } println!("${marker}"); }\n`,
      },
    };
  if (language === "java")
    return {
      image: "eclipse-temurin:21-jdk",
      argv: [
        "sh",
        "-c",
        "javac -d /tmp /workspace/Solution.java /checks/Check.java && java -cp /tmp Check",
      ],
      files: {
        "Check.java": `public class Check { public static void main(String[] args) { long[][] tests = {${tests.map((test) => `{${test.join(",")}}`).join(",")}}; for(long[] test: tests) { if(Solution.evaluate(test[0],test[1]) != test[2]) throw new RuntimeException("Acceptance failed"); } System.out.println("${marker}"); } }\n`,
      },
    };
  return {
    image: "mcr.microsoft.com/dotnet/sdk:8.0",
    argv: [
      "sh",
      "-c",
      "dotnet build /checks/check.csproj --configfile /checks/NuGet.Config -p:BaseIntermediateOutputPath=/tmp/obj/ -p:OutputPath=/tmp/out/ --nologo && dotnet /tmp/out/check.dll",
    ],
    files: {
      "Check.cs": `using System; class Check { static void Main() { long[,] tests = {${tests.map((test) => `{${test.join(",")}}`).join(",")}}; for(int i=0;i<tests.GetLength(0);i++) { if(Solution.Evaluate(tests[i,0],tests[i,1]) != tests[i,2]) throw new Exception("Acceptance failed"); } Console.WriteLine("${marker}"); } }\n`,
      "check.csproj":
        '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><EnableDefaultCompileItems>false</EnableDefaultCompileItems><AssemblyName>check</AssemblyName></PropertyGroup><ItemGroup><Compile Include="/workspace/Solution.cs"/><Compile Include="/checks/Check.cs"/></ItemGroup></Project>\n',
      "NuGet.Config":
        "<configuration><packageSources><clear/></packageSources></configuration>\n",
    },
  };
}

export const tasks = languages.flatMap((language) =>
  operations.map((operation) => {
    const id = `${language}-${operation.name}`,
      marker = `GRAPH_EVAL_OK:${id}`;
    const file = {
      javascript: "solution.mjs",
      python: "solution.py",
      go: "solution.go",
      rust: "solution.rs",
      java: "Solution.java",
      csharp: "Solution.cs",
    }[language];
    const tests = inputs.map(([x, y]) => [x, y, operation.expected(x, y)]);
    return {
      id,
      language,
      objective: `Fix the existing function. ${operation.objective}`,
      acceptance: [
        "Preserve the function signature.",
        "Pass the external checks for negative, zero, positive and equal values.",
      ],
      files: { [file]: source(language, operation.broken) },
      oracleFiles: { [file]: source(language, operation.correct) },
      tests,
      marker,
      verification: verification(language, tests, marker),
      synthetic: true,
    };
  }),
);
