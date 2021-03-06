module.exports = {
  "extends": [
    "airbnb-typescript/base",
    "plugin:@typescript-eslint/recommended-requiring-type-checking"
  ],
  "parser": "@typescript-eslint/parser",
  "parserOptions": {
    "ecmaVersion": 2019,
    "project": "tsconfig.json",
    "sourceType": "module",
    "tsconfigRootDir": __dirname,
  },
  "rules": {
    "@typescript-eslint/semi": ["warn", "never"],
    "comma-dangle": ["warn", "only-multiline"],
    "func-names": ["warn", "as-needed"],
    "import/no-cycle": ["off"],
    "import/prefer-default-export": ["off"],
    "max-len": ["warn", { "code": 120 }],
    "no-console": "off", //TODO
    "no-underscore-dangle": ["off"],
    "object-curly-newline": ["off"],
    "object-curly-spacing": ["error", "never"],
    "object-shorthand": ["off"],
    "prefer-destructuring": ["off"],
    "semi": ["warn", "never"],
    "spaced-comment": ["warn", "always", {"markers": ["/"]}]
  }
}