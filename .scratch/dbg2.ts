import { rotationalSymmetries, rotationSymmetryPermutation } from "../src/math/symmetry.js";
const pts = [{x:-2,y:1},{x:2,y:1},{x:0,y:0},{x:-2,y:-1},{x:2,y:-1}];
const p = rotationSymmetryPermutation(pts, Math.PI, 0.01);
console.log("perm pi tol1%:", p);
const p2 = rotationSymmetryPermutation(pts, Math.PI, 0.001);
console.log("perm pi tol0.1%:", p2);
console.log(rotationalSymmetries(pts, 0.01));
